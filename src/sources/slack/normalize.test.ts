import { describe, expect, it } from "vitest";
import { isBotEvent, slackToBridgeEvent } from "./normalize.js";

describe("slackToBridgeEvent", () => {
  it("trims an app_mention with names resolved", () => {
    const event = slackToBridgeEvent({
      event: {
        type: "app_mention",
        user: "U123",
        channel: "C456",
        text: "<@UBOT> please look at the failing deploy",
        ts: "1751551200.000100",
        client_msg_id: "should-not-leak",
        blocks: [{ type: "rich_text" }],
      },
      eventId: "Ev123",
      teamId: "T789",
      names: { channelName: "dev", userName: "glenn" },
    });
    expect(event).toMatchObject({
      source: "slack",
      kind: "app_mention",
      deliveryId: "Ev123",
      occurredAt: "2025-07-03T14:00:00.000Z",
    });
    expect(event?.summary).toContain("@glenn mentioned the bot in #dev");
    expect(event?.payload).toMatchObject({
      channel: "C456",
      channelName: "dev",
      user: "U123",
      userName: "glenn",
      team: "T789",
      eventType: "app_mention",
    });
    expect(JSON.stringify(event?.payload)).not.toContain("should-not-leak");
    expect(JSON.stringify(event?.payload)).not.toContain("rich_text");
  });

  it("handles plain messages, subtypes, and missing names", () => {
    const plain = slackToBridgeEvent({
      event: { type: "message", user: "U1", channel: "C1", text: "hi", ts: "1.0" },
      eventId: "Ev1",
      teamId: undefined,
      names: {},
    });
    expect(plain?.kind).toBe("message");
    expect(plain?.summary).toContain("@U1");
    expect(plain?.payload.channelName).toBeUndefined();

    const subtype = slackToBridgeEvent({
      event: { type: "message", subtype: "channel_topic", channel: "C1", ts: "1.0" },
      eventId: "Ev2",
      teamId: "T1",
      names: {},
    });
    expect(subtype?.kind).toBe("message.channel_topic");
  });

  it("truncates long text at 4000 chars", () => {
    const event = slackToBridgeEvent({
      event: { type: "message", user: "U1", channel: "C1", text: "y".repeat(9000), ts: "1.0" },
      eventId: "Ev3",
      teamId: undefined,
      names: {},
    });
    const text = event?.payload.text as string;
    expect(text.length).toBeLessThanOrEqual(4000 + "… [truncated]".length);
    expect(text).toContain("[truncated]");
  });

  it("normalizes reactions", () => {
    const event = slackToBridgeEvent({
      event: {
        type: "reaction_added",
        user: "U1",
        reaction: "rocket",
        item: { type: "message", channel: "C9", ts: "2.0" },
        event_ts: "1751551200.0",
      },
      eventId: "Ev4",
      teamId: undefined,
      names: { userName: "sam" },
    });
    expect(event?.kind).toBe("reaction_added");
    expect(event?.summary).toBe("@sam reacted :rocket: in #C9");
    expect(event?.payload).toMatchObject({ channel: "C9", reaction: "rocket", itemTs: "2.0" });
  });

  it("returns null for typeless events", () => {
    expect(
      slackToBridgeEvent({ event: {}, eventId: "Ev5", teamId: undefined, names: {} }),
    ).toBeNull();
  });
});

describe("isBotEvent", () => {
  it("flags bot messages by bot_id or subtype", () => {
    expect(isBotEvent({ type: "message", bot_id: "B1" })).toBe(true);
    expect(isBotEvent({ type: "message", subtype: "bot_message" })).toBe(true);
    expect(isBotEvent({ type: "message", user: "U1" })).toBe(false);
  });
});
