import assert from "node:assert/strict";
import test from "node:test";
import { meetupCacheControl, projectMeetup, publicProjectionLeaks, type MeetupProjectionSource } from "./meetup-public-projection";

const row: MeetupProjectionSource = {
  id: "meetup-1",
  title: "周末散步",
  description: "公开介绍",
  startsAt: "2026-12-01T10:00:00.000Z",
  place: "城市公园",
  latitude: 30.25,
  longitude: 120.16,
  maxPeople: 4,
  status: "OPEN",
  hostId: "host-1",
  adminPhone: "13800000000",
  servicePhones: [{ label: "客服", phone: "13900000000" }],
  wechatService: "secret-wechat",
  contactUrl: "https://example.test/private",
  meetingPoint: "北门细门口",
  destination: "湖心亭",
  host: { id: "host-1", name: "组织者", avatarUrl: "https://cdn.test/host.png" },
  slots: [{ id: "slot-1", name: "上午", maxPeople: 4 }],
  joins: [
    {
      userId: "user-a",
      slotId: "slot-1",
      partySize: 2,
      user: { name: "张三" },
    },
    {
      userId: "user-b",
      slotId: "slot-1",
      partySize: 1,
      user: { name: "李四" },
    },
  ],
};

test("anonymous projection keeps capacity and drops registrant identity", () => {
  const projected = projectMeetup(row, { userId: null });
  assert.equal(projected.joinCount, 3);
  assert.equal(projected.spotsLeft, 1);
  assert.equal(projected.viewerJoined, false);
  assert.equal(publicProjectionLeaks(projected).length, 0);
  assert.equal("joins" in projected, false);
  assert.equal("adminPhone" in projected, false);
  assert.equal("latitude" in projected, false);
  assert.equal((projected.host as { name: string }).name, "组织者");
  assert.equal("id" in (projected.host as object), false);
});

test("another participant only sees their own party size", () => {
  const projected = projectMeetup(row, { userId: "user-b" });
  assert.equal(projected.viewerJoined, true);
  assert.equal(projected.viewerPartySize, 1);
  assert.equal(JSON.stringify(projected).includes("张三"), false);
  assert.equal(JSON.stringify(projected).includes("user-a"), false);
  assert.equal(projected.adminPhone, "13800000000");
});

test("a logged-in stranger does not receive the roster, contact fields, or host id", () => {
  const projected = projectMeetup(row, { userId: "user-c" });
  assert.equal(projected.audience, "public");
  assert.equal("participants" in projected, false);
  assert.equal("adminPhone" in projected, false);
  assert.equal("hostId" in projected, false);
  assert.equal(JSON.stringify(projected).includes("user-a"), false);
});

test("organizer receives display names without user ids", () => {
  const projected = projectMeetup(row, { userId: "host-1" });
  const roster = projected.participants as Array<{ displayName: string }>;
  assert.deepEqual(roster.map((item) => item.displayName), ["李四", "张三"]);
  assert.equal(JSON.stringify(roster).includes("user-a"), false);
  assert.equal(JSON.stringify(roster).includes("avatar"), false);
});

test("another organizer is not this activity's organizer", () => {
  const projected = projectMeetup(row, { userId: "host-2", isManager: false });
  assert.equal(projected.audience, "public");
  assert.equal("participants" in projected, false);
});

test("manager can see the roster", () => {
  const projected = projectMeetup(row, { userId: "admin-1", isManager: true });
  assert.equal(projected.audience, "organizer");
});

test("personalized responses are not stored in a shared cache", () => {
  assert.equal(meetupCacheControl({ hasSession: false }), "public, max-age=0, must-revalidate");
  assert.match(meetupCacheControl({ hasSession: true }), /private/);
});
