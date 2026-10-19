import Link from "next/link";
export async function StudioNav(_props:{current?:string;area?:string}) { return <nav className="container py-4 flex gap-4"><Link href="/meetup">约搭</Link><Link href="/studio/meetup">管理</Link></nav>; }
