import Link from "next/link";
import {safeNextPath} from "@andyyyds/shared/safe-next-path";
export default async function Login({searchParams}:{searchParams:Promise<{next?:string;error?:string}>}){const q=await searchParams;return <section className="container py-8"><h1>登录约搭</h1>{q.error?<p role="alert">{q.error}</p>:null}<Link href={"/api/auth/account/start?next="+encodeURIComponent(safeNextPath(q.next||"/meetup"))}>使用统一账号登录</Link></section>;}
