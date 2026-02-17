import { App } from "@slack/bolt";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import child_process from "node:child_process";

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
    {
      name: "read_file",
      description: "Read the contents of a file at the given path.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path to read",
          },
        },
        required: ["path"],
      },
      execute: async (input: { path: string }) => {
        return fs.readFileSync(input.path, "utf-8");
      },
    },
    {
      name: "write_file",
      description:
        "Write content to a file at the given path. Creates the file if it doesn't exist, overwrites if it does.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file path to read",
          },
          content: {
            type: "string",
            description: "The content to write",
          },
        },
        required: ["path"],
      },
      execute: async (input: { path: string; content: string }) => {
        fs.writeFileSync(input.path, input.content);
        return "File written.";
      },
    },
    {
      name: "execute_bash",
      description: "Execute a bash command and return its output.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute.",
          },
        },
        required: ["command"],
      },
      execute: async (input: { command: string }) => {
        try {
          const output = child_process.execSync(input.command, {
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return output || "(no output)";
        } catch (e: any) {
          const parts = [
            e.stdout ? `stdout:\n${e.stdout}` : "",
            e.stderr ? `stderr:\n${e.stderr}` : "",
            e.killed ? "Error: command timed out" : "",
          ].filter(Boolean);
          return parts.length > 0 ? parts.join("\n") : `Error: ${e.message}`;
        }
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

const activeThreadLoops = new Set<string>();
const pendingUserMessages = new Map<string, Anthropic.MessageParam[]>();

async function runThreadLoop(threadTs: string, channel: string): Promise<void> {
  // Ensure there is only one loop per Slack thread
  if (activeThreadLoops.has(threadTs)) {
    return;
  }
  activeThreadLoops.add(threadTs);

  try {
    while (true) {
      let thread: Thread = loadThread(threadTs) ?? {
        threadTs,
        channel,
        messages: [],
      };
      // Add the pending user messages to the thread
      const pending = pendingUserMessages.get(threadTs) ?? [];
      thread.messages = [...thread.messages, ...pending];
      pendingUserMessages.delete(threadTs);

      const lastMessage = thread.messages[thread.messages.length - 1]!;
      // If the last message is an assistant message and doesn't contain any tool calls, we're done looping
      if (
        lastMessage.role === "assistant" &&
        typeof lastMessage.content !== "string" &&
        !lastMessage.content.some((block) => block.type === "tool_result")
      ) {
        break;
      }
      const messages = await generateMessages({
        channel,
        threadTs,
        messages: thread.messages,
        system: "You are a helpful Slack assistant.",
      });

      saveThread(threadTs, {
        ...thread,
        messages,
      });
    }
  } finally {
    activeThreadLoops.delete(threadTs);
  }
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

  const pending = pendingUserMessages.get(threadTs) ?? [];
  pending.push({
    role: "user",
    content: `User <@${event.user}> sent this message (timestamp: ${event.ts}) in Slack:\n\`\`\`\n${event.text}\n\`\`\`\n\nYou must respond using the \`send_slack_message\` tool.`,
  });
  pendingUserMessages.set(threadTs, pending);

  runThreadLoop(threadTs, channel);
});

console.log("Slack agent running");
app.start();
