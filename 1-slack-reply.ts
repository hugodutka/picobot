import { App } from "@slack/bolt";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

app.event("message", async ({ event, client }) => {
  console.log("Received message event at", new Date().toLocaleString());
  if (event.subtype || event.channel_type !== "im") {
    return;
  }
  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.thread_ts ?? event.ts,
    text: `Hey! Your Slack user id is \`${event.user}\` - you'll need it later.`,
  });
});

console.log("Slack agent running");
app.start();
