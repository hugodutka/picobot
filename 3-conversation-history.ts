import { App } from "@slack/bolt";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const anthropic = new Anthropic();

type ToolWithExecute = Anthropic.Tool & {
  execute: (input: any) => Promise<any>;
};

const configDir = path.resolve(os.homedir(), ".picobot");
const threadsDir = path.resolve(configDir, "threads");

interface Thread {
  threadTs: string;
  channel: string;
  messages: Anthropic.MessageParam[];
}

function saveThread(threadTs: string, thread: Thread): void {
  fs.mkdirSync(threadsDir, { recursive: true });
  return fs.writeFileSync(
    path.resolve(threadsDir, `${threadTs}.json`),
    JSON.stringify(thread, null, 2)
  );
}

function loadThread(threadTs: string): Thread | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(threadsDir, `${threadTs}.json`), "utf-8")
    );
  } catch (e) {
    return undefined;
  }
}

function createTools(channel: string, threadTs: string): ToolWithExecute[] {
  return [
    {
      name: "send_slack_message",
      description:
        "Send a message to the user in Slack. This is the only way to communicate with the user.",
      input_schema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "The message text (supports Slack mrkdwn formatting)",
          },
        },
        required: ["text"],
      },
      execute: async (input: { text: string }) => {
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: input.text,
          blocks: [
            {
              type: "markdown",
              text: input.text,
            },
          ],
        });
        return "Message sent.";
      },
    },
  ];
}

async function generateMessages(args: {
  channel: string;
  threadTs: string;
  system: string;
  messages: Anthropic.MessageParam[];
}): Promise<Anthropic.MessageParam[]> {
  const { channel, threadTs, system, messages } = args;
  const tools = createTools(channel, threadTs);

  console.log("Generating messages for thread", threadTs);
  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 8096,
    system,
    messages,
    tools,
  });
  console.log(
    `Response generated for thread ${threadTs}: ${response.usage.output_tokens} tokens`
  );

  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  for (const block of response.content) {
    if (block.type !== "tool_use") {
      continue;
    }
    try {
      console.log(`Agent used tool ${block.name}`);
      const tool = toolsByName.get(block.name);
      if (!tool) {
        throw new Error(`tool "${block.name}" not found`);
      }
      const result = await tool.execute(block.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    } catch (e: any) {
      console.warn(`Agent tried to use tool ${block.name} but failed`, e);
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: `Error: ${e.message}`,
        is_error: true,
      });
    }
  }

  messages.push({ role: "assistant", content: response.content });
  if (toolResults.length > 0) {
    messages.push({
      role: "user",
      content: toolResults,
    });
  }

  return messages;
}

app.event("message", async ({ event }) => {
  if (event.subtype || event.channel_type !== "im") {
    return;
  }
  const threadTs = event.thread_ts ?? event.ts;
  const channel = event.channel;

  // Only allow authorized users to interact with the bot
  if (event.user !== process.env.SLACK_USER_ID) {
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `I'm sorry, I'm not authorized to respond to messages from you. Set the \`SLACK_USER_ID\` environment variable to \`${event.user}\` to allow me to respond to your messages.`,
    });
    return;
  }

  // Show a typing indicator to the user while we generate the response
  // It'll be auto-cleared once the agent sends a Slack message
  await app.client.assistant.threads.setStatus({
    channel_id: channel,
    thread_ts: threadTs,
    status: "is typing...",
  });

  const thread: Thread = loadThread(threadTs) ?? {
    threadTs,
    channel,
    messages: [],
  };
  const messages = await generateMessages({
    channel: event.channel,
    threadTs,
    system: "You are a helpful Slack assistant.",
    messages: [
      ...thread.messages,
      {
        role: "user",
        content: `User <@${event.user}> sent this message (timestamp: ${event.ts}) in Slack:\n\`\`\`\n${event.text}\n\`\`\`\n\nYou must respond using the \`send_slack_message\` tool.`,
      },
    ],
  });
  saveThread(threadTs, {
    ...thread,
    messages,
  });
});

console.log("Slack agent running");
app.start();
