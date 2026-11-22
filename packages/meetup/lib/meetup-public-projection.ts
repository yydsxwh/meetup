/**
 * 活动公开投影。
 * 匿名和没有报名权限的登录者只看聚合信息。
 * 报名者只看自己的人数和档期。组织者才看报名名单里的展示名。
 * 名单不带用户 ID、头像和报名记录 ID。联系电话、坐标和详细集合点默认不公开。
 */

import { fromMeetupPeopleDb } from "./meetup";
import { sumMeetupPartySize, type MeetupServicePhone } from "./meetup-service-contact";

export type MeetupJoinSource = {
  userId: string;
  slotId?: string | null;
  partySize?: number | null;
  createdAt?: Date | string | null;
  user?: { name?: string | null } | null;
};

export type MeetupProjectionSource = {
  id: string;
  title: string;
  description?: string | null;
  contentHtml?: string | null;
  priceCents?: number | null;
  category?: string | null;
  startsAt: Date | string;
  endsAt?: Date | string | null;
  timezone?: string | null;
  place?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  maxPeople: bigint | number | string;
  coverUrl?: string | null;
  tags?: string[];
  feeIncludes?: string | null;
  refundPolicy?: string | null;
  autoRefund?: boolean | null;
  gallery?: string[];
  contactUrl?: string | null;
  meetingPoint?: string | null;
  destination?: string | null;
  highlights?: string | null;
  adminPhone?: string | null;
  servicePhones?: MeetupServicePhone[];
  wechatService?: string | null;
  itineraryHtml?: string | null;
  feeNoteHtml?: string | null;
  notesHtml?: string | null;
  status: string;
  hostId: string;
  productCourseId?: string | null;
  createdAt?: Date | string | null;
  host: { id: string; name: string; avatarUrl?: string | null };
  slots?: Array<{ id: string; name: string; maxPeople: bigint | number | string; sortOrder?: number }>;
  joins: MeetupJoinSource[];
};

export type MeetupViewer = {
  userId: string | null;
  isManager?: boolean;
};

export type MeetupAudience = "public" | "participant" | "organizer";

const FORBIDDEN_ON_PUBLIC = [
  "adminPhone",
  "servicePhones",
  "wechatService",
  "contactUrl",
  "latitude",
  "longitude",
  "meetingPoint",
  "destination",
  "joins",
  "participants",
  "hostId",
  "userId",
] as const;

export function meetupAudience(row: { hostId: string; joins: Array<{ userId: string }> }, viewer: MeetupViewer): MeetupAudience {
  if (viewer.userId && (viewer.userId === row.hostId || viewer.isManager)) return "organizer";
  if (viewer.userId && row.joins.some((join) => join.userId === viewer.userId)) return "participant";
  return "public";
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function projectMeetup(row: MeetupProjectionSource, viewer: MeetupViewer) {
  const audience = meetupAudience(row, viewer);
  const maxPeople = fromMeetupPeopleDb(row.maxPeople);
  const joinCount = sumMeetupPartySize(row.joins);
  const own = viewer.userId ? row.joins.find((join) => join.userId === viewer.userId) : undefined;
  const revealContact = audience === "participant" || audience === "organizer";
  const revealIdentity = audience === "organizer";
  const slots = (row.slots || []).map((slot) => ({
    id: slot.id,
    name: slot.name,
    maxPeople: fromMeetupPeopleDb(slot.maxPeople),
    sortOrder: slot.sortOrder ?? 0,
    joinCount: sumMeetupPartySize(row.joins.filter((join) => join.slotId === slot.id)),
  }));

  const projected: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    description: row.description || "",
    contentHtml: row.contentHtml || "",
    priceCents: Math.max(0, Math.floor(row.priceCents || 0)),
    category: row.category || "",
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    timezone: row.timezone || "Asia/Shanghai",
    place: row.place || "",
    maxPeople,
    coverUrl: row.coverUrl || "",
    tags: row.tags || [],
    feeIncludes: row.feeIncludes || "",
    refundPolicy: row.refundPolicy || "",
    autoRefund: Boolean(row.autoRefund),
    gallery: row.gallery || [],
    highlights: row.highlights || "",
    itineraryHtml: row.itineraryHtml || "",
    feeNoteHtml: row.feeNoteHtml || "",
    notesHtml: row.notesHtml || "",
    status: row.status,
    productCourseId: row.productCourseId || null,
    slots,
    host: revealIdentity
      ? { id: row.host.id, name: row.host.name, avatarUrl: row.host.avatarUrl || "" }
      : { name: row.host.name },
    joinCount,
    spotsLeft: Math.max(maxPeople - joinCount, 0),
    createdAt: iso(row.createdAt),
    audience,
    viewerJoined: Boolean(own),
    viewerIsHost: Boolean(viewer.userId && viewer.userId === row.hostId),
    viewerPartySize: own ? Math.max(1, Math.floor(Number(own.partySize) || 1)) : null,
    viewerSlotId: own?.slotId || null,
  };

  if (revealIdentity) projected.hostId = row.hostId;
  if (revealContact) {
    projected.adminPhone = row.adminPhone || "";
    projected.servicePhones = row.servicePhones || [];
    projected.wechatService = row.wechatService || "";
    projected.contactUrl = row.contactUrl || "";
    projected.meetingPoint = row.meetingPoint || "";
    projected.destination = row.destination || "";
    projected.latitude = row.latitude ?? null;
    projected.longitude = row.longitude ?? null;
    projected.ownJoin = own
      ? {
          partySize: Math.max(1, Math.floor(Number(own.partySize) || 1)),
          slotId: own.slotId || null,
        }
      : null;
  }
  if (audience === "organizer") {
    projected.participants = [...row.joins].reverse().map((join, index) => ({
      key: `roster-${index}`,
      displayName: (join.user?.name || "").trim() || "报名者",
      partySize: Math.max(1, Math.floor(Number(join.partySize) || 1)),
      slotId: join.slotId || null,
    }));
  }
  return projected;
}

export function publicProjectionLeaks(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if ((FORBIDDEN_ON_PUBLIC as readonly string[]).includes(key) && key !== "hostId") {
        found.push(path ? `${path}.${key}` : key);
      }
      if (key === "userId" || key === "avatarUrl" || key === "id" && path.includes("participant")) {
        found.push(path ? `${path}.${key}` : key);
      }
      walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(value, "");
  return found;
}

export function meetupCacheControl(input: { hasSession: boolean }): string {
  return input.hasSession ? "private, no-store" : "public, max-age=0, must-revalidate";
}
