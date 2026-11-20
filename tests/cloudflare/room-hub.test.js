import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function roomHub(label) {
  return env.ROOM_HUB.getByName(label + "-" + crypto.randomUUID());
}

describe("RoomHub Push-to-Talk lease", () => {
  it("atomically grants a room to only one simultaneous speaker", async () => {
    const hub = roomHub("parallel-claim");
    const results = await Promise.all([
      hub.acquireSpeaker("member-a", "عضو الف", "socket-a"),
      hub.acquireSpeaker("member-b", "عضو ب", "socket-b")
    ]);

    expect(results.filter(result => result.ok)).toHaveLength(1);
    const current = await hub.getSpeaker();
    expect(current).not.toBeNull();
    expect(["member-a", "member-b"]).toContain(current.userId);
    expect(["socket-a", "socket-b"]).toContain(current.connectionKey);
  });

  it("does not let a second device renew or release another device's lease", async () => {
    const hub = roomHub("connection-owner");
    const claimed = await hub.acquireSpeaker("member-a", "عضو الف", "socket-a");
    expect(claimed.ok).toBe(true);

    expect(await hub.renewSpeaker("member-a", "socket-b")).toBe(false);
    await hub.releaseSpeaker("member-a", "socket-b");

    const stillOwned = await hub.getSpeaker();
    expect(stillOwned).toMatchObject({
      userId: "member-a",
      connectionKey: "socket-a"
    });

    await hub.releaseSpeaker("member-a", "socket-a");
    expect(await hub.getSpeaker()).toBeNull();
  });

  it("allows the owning connection to renew its lease", async () => {
    const hub = roomHub("owner-renewal");
    const claimed = await hub.acquireSpeaker("member-a", "عضو الف", "socket-a");
    expect(claimed.ok).toBe(true);

    expect(await hub.renewSpeaker("member-a", "socket-a")).toBe(true);
    expect(await hub.getSpeaker()).toMatchObject({
      userId: "member-a",
      connectionKey: "socket-a"
    });
  });

  it("does not allow a different account to replace an active lease", async () => {
    const hub = roomHub("different-account");
    await hub.acquireSpeaker("member-a", "عضو الف", "socket-a");

    const rejected = await hub.acquireSpeaker("member-b", "عضو ب", "socket-b");
    expect(rejected.ok).toBe(false);
    expect(rejected.speaker).toMatchObject({
      userId: "member-a",
      connectionKey: "socket-a"
    });
  });
});
