# 约搭（meetup）

从 [Andyyyds](https://github.com/yydsxwh/Andyyyds) 完整迁出的约搭产品：发局、报名、组队集合，支持免费或收费报名、图文视频详情、地图选点、时区、分档名额、咨询私聊与约搭群。

约搭的登录、支付、优惠券、分销、私聊/群聊、图片上传、国际化等能力依赖同一套站点壳，因此本库一并带上 `@andyyyds/shared` 与站点路由，保证功能可独立跑通。

## 功能

- **约搭广场**：分类、最新 / 距离最近 / 综合排序
- **发起约搭**：封面、富媒体详情、分档名额、安心卡片、图集、客服电话/微信
- **时间与地点**：IANA 时区、墙钟时间、地图选点（高德 / OSM）、距离排序
- **报名**：免费直接报名；收费走订单支付（可叠加优惠券与分销）
- **工作室**：约搭管理、我的约搭、编辑 / 取消 / 删除
- **社交**：向发起人咨询私聊；报名后自动进约搭群

## 技术栈

- Next.js 16 + TypeScript + Tailwind CSS
- Prisma + SQLite
- Cookie Session（jose + bcryptjs）

## 快速开始

```bash
npm install
npm run db:reset
npm run dev
```

浏览器打开 [http://localhost:3000/meetup](http://localhost:3000/meetup)

### 演示账号

| 角色 | 邮箱 | 密码 |
|------|------|------|
| 学员 | student@yyds.local | 123456 |
| 讲师 | teacher@yyds.local | 123456 |
| 管理员 | admin@yyds.local | 123456 |

优惠券：`YYDS20`（满 99 减 20）

## 目录

- `packages/meetup`（`@andyyyds/meetup`）约搭业务：广场、详情、发起/编辑、工作室、API
- `packages/shared`（`@andyyyds/shared`）登录、支付、权限、国际化、聊天、存储
- `src/app/meetup`、`src/app/studio/meetup`、`src/app/api/meetup` 路由薄入口
- `src/app/api/geo` 约搭选点 / 时区 / 地图瓦片
- `prisma` 数据模型（`Meetup` / `MeetupSlot` / `MeetupJoin`）与种子数据
