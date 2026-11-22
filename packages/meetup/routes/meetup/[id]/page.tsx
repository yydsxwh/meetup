import { notFound } from "next/navigation";
import {
  MeetupDetailView,
  type MeetupDetailData,
} from "@andyyyds/meetup/components/meetup-detail-view";
import { getSession } from "@andyyyds/shared/auth";
import { prisma } from "@andyyyds/shared/db";
import { parseJsonStringArray } from "@andyyyds/meetup/lib/meetup-meta";
import {
  parseMeetupServicePhones,
} from "@andyyyds/meetup/lib/meetup-service-contact";
import { projectMeetup } from "@andyyyds/meetup/lib/meetup-public-projection";
import { canManageMeetups } from "@andyyyds/shared/roles";
import { resolveContentFields } from "@andyyyds/shared/i18n/content-resolve";
import { getRequestLocaleContext } from "@andyyyds/shared/i18n/get-request-locale";
import {
  getHideAllPricesFlag,
  getOrderFormConfig,
  getPortalConfig,
} from "@andyyyds/shared/site-settings";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const meetup = await prisma.meetup.findUnique({
    where: { id },
    select: { title: true },
  });
  return {
    title: meetup?.title ? `${meetup.title} · 约搭` : "约搭详情",
  };
}

export default async function MeetupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getSession();

  let meetup = await prisma.meetup.findUnique({
    where: { id },
    include: {
      host: { select: { id: true, name: true, avatarUrl: true } },
      slots: { orderBy: { sortOrder: "asc" } },
      joins: {
        select: {
          userId: true,
          slotId: true,
          partySize: true,
          createdAt: true,
          user: { select: { name: true } },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!meetup) notFound();

  const inviteCode = session
    ? (
        await prisma.user.findUnique({
          where: { id: session.id },
          select: { referralCode: true },
        })
      )?.referralCode || ""
    : "";

  const [orderForm, portal, hideAllPrices, productCourse] = await Promise.all([
    getOrderFormConfig(),
    getPortalConfig(),
    getHideAllPricesFlag(),
    meetup.productCourseId
      ? prisma.course.findUnique({
          where: { id: meetup.productCourseId },
          select: { hidePrice: true },
        })
      : Promise.resolve(null),
  ]);
  const siteContact = portal.contact;
  const localeCtx = await getRequestLocaleContext();
  const loc = await resolveContentFields({
    entityType: "meetup",
    entityId: meetup.id,
    fields: {
      title: meetup.title,
      description: meetup.description || "",
      contentHtml: meetup.contentHtml || "",
      place: meetup.place || "",
      meetingPoint: meetup.meetingPoint || "",
      destination: meetup.destination || "",
      highlights: meetup.highlights || "",
      feeIncludes: meetup.feeIncludes || "",
      refundPolicy: meetup.refundPolicy || "",
    },
    locale: localeCtx.contentLocale,
  });
  // 站长：主显中文；访客：主显当前 locale 译文（无缓存则原文）
  const withBi = (field: keyof typeof loc) => {
    const row = loc[field];
    if (!localeCtx.bilingual) return row.text;
    return row.source || row.text;
  };
  const secondary = (field: keyof typeof loc) => {
    if (!localeCtx.bilingual) return undefined;
    const row = loc[field];
    if (row.text && row.text !== row.source) return row.text;
    return undefined;
  };

  const projected = projectMeetup(
    {
      id: meetup.id,
      title: meetup.title,
      description: meetup.description,
      contentHtml: meetup.contentHtml,
      priceCents: meetup.priceCents,
      category: meetup.category,
      startsAt: meetup.startsAt,
      endsAt: meetup.endsAt,
      timezone: meetup.timezone,
      place: meetup.place,
      latitude: meetup.latitude,
      longitude: meetup.longitude,
      maxPeople: meetup.maxPeople,
      coverUrl: meetup.coverUrl,
      tags: parseJsonStringArray(meetup.tagsJson),
      feeIncludes: meetup.feeIncludes,
      refundPolicy: meetup.refundPolicy,
      autoRefund: meetup.autoRefund,
      gallery: parseJsonStringArray(meetup.galleryJson),
      contactUrl: meetup.contactUrl,
      meetingPoint: meetup.meetingPoint,
      destination: meetup.destination,
      highlights: meetup.highlights,
      adminPhone: meetup.adminPhone,
      servicePhones: parseMeetupServicePhones(meetup.servicePhonesJson),
      wechatService: meetup.wechatService,
      itineraryHtml: meetup.itineraryHtml,
      feeNoteHtml: meetup.feeNoteHtml,
      notesHtml: meetup.notesHtml,
      status: meetup.status,
      hostId: meetup.hostId,
      productCourseId: meetup.productCourseId,
      createdAt: meetup.createdAt,
      host: meetup.host,
      slots: meetup.slots,
      joins: meetup.joins,
    },
    {
      userId: session?.id ?? null,
      isManager: session ? canManageMeetups(session.role) : false,
    },
  );
  const data = {
    ...projected,
    title: withBi("title"),
    titleSecondary: secondary("title"),
    description: withBi("description"),
    contentHtml: withBi("contentHtml") || "",
    place: withBi("place"),
    placeSecondary: secondary("place"),
    feeIncludes: withBi("feeIncludes") || "",
    refundPolicy: withBi("refundPolicy") || "",
    meetingPoint: projected.meetingPoint ? withBi("meetingPoint") || "" : "",
    destination: projected.destination ? withBi("destination") || "" : "",
    highlights: projected.highlights ? withBi("highlights") || "" : "",
    hidePrice: Boolean(productCourse?.hidePrice),
    joins: [],
    hostId: typeof projected.hostId === "string" ? projected.hostId : "",
    host: {
      id: typeof projected.hostId === "string" ? projected.hostId : "",
      name: (projected.host as { name: string }).name,
      avatarUrl: (projected.host as { avatarUrl?: string }).avatarUrl || "",
    },
  } as MeetupDetailData;

  return (
    <MeetupDetailView
      meetup={data}
      currentUserId={session?.id ?? null}
      inviteCode={inviteCode}
      orderForm={orderForm}
      siteContact={{
        phone: siteContact?.phone || "",
        wechat: siteContact?.wechat || "",
        title: siteContact?.title || "网站联系方式",
      }}
      canManageAsAdmin={
        session ? canManageMeetups(session.role) : false
      }
      hideAllPrices={hideAllPrices}
    />
  );
}
