/**
 * GET  /api/meetup —— 广场列表（category / sort=latest|nearest|score / lat&lng）
 * POST /api/meetup —— 发起约搭（任意登录用户，不限角色；可设价、分档、安心文案、富媒体）
 *
 * 站长全站 CRUD 在 /api/studio/meetups，勿把创建收紧成仅 ADMIN。
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@andyyyds/shared/auth";
import { prisma } from "@andyyyds/shared/db";
import {
  buildMeetupPlazaWhere,
  fromMeetupPeopleDb,
  MEETUP_PLAZA_TAKE,
  parseMeetupSort,
  parseOptionalCoord,
  sortMeetupPlazaRows,
  toMeetupPeopleDb,
} from "@andyyyds/meetup/lib/meetup";
import { normalizeMeetupTimeZone } from "@andyyyds/meetup/lib/meetup-timezone";
import { parseJsonStringArray } from "@andyyyds/meetup/lib/meetup-meta";
import {
  meetupWriteSchema,
  parseMeetupWriteBody,
} from "@andyyyds/meetup/lib/meetup-payload";
import { ensureMeetupProductCourse } from "@andyyyds/meetup/lib/meetup-product";
import {
  parseMeetupServicePhones,
  sumMeetupPartySize,
} from "@andyyyds/meetup/lib/meetup-service-contact";
import { meetupCacheControl, projectMeetup, type MeetupViewer } from "@andyyyds/meetup/lib/meetup-public-projection";
import { canManageMeetups } from "@andyyyds/shared/roles";

function serializeMeetup(row: {
  id: string;
  title: string;
  description: string;
  contentHtml?: string;
  priceCents?: number;
  category: string;
  startsAt: Date;
  endsAt?: Date | null;
  timezone?: string | null;
  place: string;
  latitude?: number | null;
  longitude?: number | null;
  maxPeople: number | bigint;
  coverUrl: string;
  tagsJson?: string;
  feeIncludes?: string;
  refundPolicy?: string;
  autoRefund?: boolean;
  galleryJson?: string;
  contactUrl?: string;
  meetingPoint?: string;
  destination?: string;
  highlights?: string;
  adminPhone?: string;
  servicePhonesJson?: string;
  wechatService?: string;
  itineraryHtml?: string;
  feeNoteHtml?: string;
  notesHtml?: string;
  status: string;
  hostId: string;
  productCourseId?: string | null;
  createdAt: Date;
  host: { id: string; name: string; avatarUrl: string };
  slots?: {
    id: string;
    name: string;
    maxPeople: number | bigint;
    sortOrder: number;
    joins?: { id: string; userId: string; partySize?: number | null }[];
    _count?: { joins: number };
  }[];
  joins: {
    id: string;
    userId: string;
    slotId?: string | null;
    partySize?: number | null;
    createdAt: Date;
    user?: { id: string; name: string; avatarUrl: string };
  }[];
  _count?: { joins: number };
}, viewer: MeetupViewer = { userId: null }) {
  return projectMeetup(
    {
      id: row.id,
      title: row.title,
      description: row.description,
      contentHtml: row.contentHtml,
      priceCents: row.priceCents,
      category: row.category,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      timezone: normalizeMeetupTimeZone(row.timezone),
      place: row.place,
      latitude: row.latitude,
      longitude: row.longitude,
      maxPeople: row.maxPeople,
      coverUrl: row.coverUrl,
      tags: parseJsonStringArray(row.tagsJson),
      feeIncludes: row.feeIncludes,
      refundPolicy: row.refundPolicy,
      autoRefund: row.autoRefund,
      gallery: parseJsonStringArray(row.galleryJson),
      contactUrl: row.contactUrl,
      meetingPoint: row.meetingPoint,
      destination: row.destination,
      highlights: row.highlights,
      adminPhone: row.adminPhone,
      servicePhones: parseMeetupServicePhones(row.servicePhonesJson),
      wechatService: row.wechatService,
      itineraryHtml: row.itineraryHtml,
      feeNoteHtml: row.feeNoteHtml,
      notesHtml: row.notesHtml,
      status: row.status,
      hostId: row.hostId,
      productCourseId: row.productCourseId,
      createdAt: row.createdAt,
      host: row.host,
      slots: row.slots,
      joins: row.joins,
    },
    viewer,
  );
}

const meetupInclude = {
  host: { select: { id: true, name: true, avatarUrl: true } },
  slots: { orderBy: { sortOrder: "asc" as const } },
  joins: {
    select: {
      userId: true,
      slotId: true,
      partySize: true,
      createdAt: true,
      user: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
  _count: { select: { joins: true } },
};

export async function GET(req: Request) {
  const session = await getSession();
  const viewer: MeetupViewer = {
    userId: session?.id ?? null,
    isManager: session ? canManageMeetups(session.role) : false,
  };
  const { searchParams } = new URL(req.url);
  const category = searchParams.get("category")?.trim() || "";
  // past=1：兼容旧客户端；时间窗已取消，与默认行为相同
  const includePast = searchParams.get("past") === "1";
  const sort = parseMeetupSort(searchParams.get("sort"));
  const userLat = parseOptionalCoord(searchParams.get("lat"), "lat");
  const userLng = parseOptionalCoord(searchParams.get("lng"), "lng");

  const where = buildMeetupPlazaWhere({ category, includePast });

  const rows = await prisma.meetup.findMany({
    where,
    include: meetupInclude,
    orderBy:
      sort === "latest"
        ? [{ createdAt: "desc" }, { startsAt: "desc" }]
        : [{ startsAt: "desc" }, { createdAt: "desc" }],
    take: MEETUP_PLAZA_TAKE,
  });

  const sorted = sortMeetupPlazaRows(
    rows.map((row) => ({
      ...row,
      maxPeople: fromMeetupPeopleDb(row.maxPeople),
      joinCount: sumMeetupPartySize(row.joins),
    })),
    { sort, userLat, userLng },
  );

  return NextResponse.json({
    meetups: sorted.map((row) => serializeMeetup(row, viewer)),
    sort,
    // 便于前端提示：距离排序是否拿到了用户坐标
    geo: {
      used:
        typeof userLat === "number" &&
        typeof userLng === "number" &&
        Number.isFinite(userLat) &&
        Number.isFinite(userLng),
      lat: userLat,
      lng: userLng,
    },
  }, {
    headers: {
      "Cache-Control": meetupCacheControl({ hasSession: Boolean(session) }),
      Vary: "Cookie",
    },
  });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录后再发起约搭" }, { status: 401 });
  }

  try {
    const body = meetupWriteSchema.parse(await req.json());
    const parsed = parseMeetupWriteBody(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const data = parsed.data;

    const meetup = await prisma.$transaction(async (tx) => {
      const created = await tx.meetup.create({
        data: {
          title: data.title,
          description: data.description,
          contentHtml: data.contentHtml,
          priceCents: data.priceCents,
          category: data.category,
          startsAt: data.startsAt,
          endsAt: data.endsAt,
          timezone: data.timezone,
          place: data.place,
          latitude: data.latitude,
          longitude: data.longitude,
          maxPeople: toMeetupPeopleDb(data.maxPeople),
          coverUrl: data.coverUrl,
          tagsJson: data.tagsJson,
          feeIncludes: data.feeIncludes,
          refundPolicy: data.refundPolicy,
          autoRefund: data.autoRefund,
          galleryJson: data.galleryJson,
          contactUrl: data.contactUrl,
          meetingPoint: data.meetingPoint,
          destination: data.destination,
          highlights: data.highlights,
          adminPhone: data.adminPhone,
          servicePhonesJson: data.servicePhonesJson,
          wechatService: data.wechatService,
          itineraryHtml: data.itineraryHtml,
          feeNoteHtml: data.feeNoteHtml,
          notesHtml: data.notesHtml,
          status: "OPEN",
          hostId: session.id,
          slots: {
            create: data.slots.map((s, i) => ({
              name: s.name,
              maxPeople: toMeetupPeopleDb(s.maxPeople),
              sortOrder: i,
            })),
          },
        },
        include: { slots: { orderBy: { sortOrder: "asc" } } },
      });

      // 发起人占第一档一席，本人不付报名费
      const hostSlotId = created.slots[0]?.id || null;
      await tx.meetupJoin.create({
        data: {
          meetupId: created.id,
          userId: session.id,
          slotId: hostSlotId,
          partySize: 1,
        },
      });

      await ensureMeetupProductCourse(tx, {
        id: created.id,
        title: created.title,
        description: created.description,
        contentHtml: created.contentHtml,
        coverUrl: created.coverUrl,
        priceCents: created.priceCents,
        hidePrice: data.hidePrice,
        hostId: created.hostId,
        status: created.status,
      });

      return tx.meetup.findUniqueOrThrow({
        where: { id: created.id },
        include: meetupInclude,
      });
    });

    return NextResponse.json(
      {
        meetup: serializeMeetup(meetup, {
          userId: session.id,
          isManager: canManageMeetups(session.role),
        }),
      },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "请完整填写约搭信息" }, { status: 400 });
    }
    console.error("[meetup:create]", error);
    return NextResponse.json({ error: "发起失败，请稍后重试" }, { status: 500 });
  }
}
