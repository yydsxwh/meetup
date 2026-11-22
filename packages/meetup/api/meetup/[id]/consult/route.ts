/**
 * POST /api/meetup/[id]/consult
 * 登录用户向活动发起人发私聊。响应里不返回发起人的用户 ID。
 */

import { NextResponse } from "next/server";
import { getSession } from "@andyyyds/shared/auth";
import { CHAT_SOURCE } from "@andyyyds/shared/chat/constants";
import { requestDirectChat } from "@andyyyds/shared/chat/service";
import { prisma } from "@andyyyds/shared/db";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const meetup = await prisma.meetup.findUnique({
    where: { id },
    select: { id: true, hostId: true },
  });
  if (!meetup) {
    return NextResponse.json({ error: "活动不存在" }, { status: 404 });
  }
  if (meetup.hostId === session.id) {
    return NextResponse.json({ error: "不能和自己发起私聊" }, { status: 400 });
  }
  try {
    const result = await requestDirectChat({
      requesterId: session.id,
      peerUserId: meetup.hostId,
      source: CHAT_SOURCE.MEETUP_CONSULT,
      relatedMeetupId: meetup.id,
    });
    console.info(JSON.stringify({ event: "meetup_consult", meetupId: meetup.id, actorId: session.id }));
    return NextResponse.json(
      {
        conversationId: result.conversation.id,
        status: result.conversation.status,
        created: result.created,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "发起失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
