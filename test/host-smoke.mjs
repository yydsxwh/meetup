import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const dir=process.cwd();
const repo=JSON.parse(readFileSync(path.join(dir,"package.json"),"utf8")).name;
assert(["mathcode","meetup"].includes(repo),"unsupported product");
const port=Number(process.env.TEST_PORT || process.argv[2] || (repo==="mathcode"?45313:45315));
const require=createRequire(dir+"/package.json");
const { PrismaClient }=require("@prisma/client");
const { SignJWT }=await import(require.resolve("jose"));
const secret="isolated-host-check-"+repo+"-unique-secret-32";
const databaseUrl="file:"+path.join(mkdtempSync(path.join(tmpdir(),"product-host-")),"test.db");
const origin="http://127.0.0.1:"+port;
const env={...process.env,DATABASE_URL:databaseUrl,AUTH_SECRET:secret,ACCOUNT_CLIENT_ID:"",ACCOUNT_CLIENT_SECRET:"",ACCOUNT_ISSUER:"",SITE_URL:origin,NEXT_PUBLIC_SITE_URL:origin,MULTI_ACCOUNT_TABS:"0"};
async function run(command,args){const code=await new Promise(resolve=>{const p=spawn(command,args,{cwd:dir,env,stdio:"inherit"});p.on("exit",resolve);p.on("error",()=>resolve(1));});assert.equal(code,0);}
await run("node_modules/.bin/prisma",["db","push","--skip-generate"]);
const db=new PrismaClient({datasources:{db:{url:databaseUrl}}});
for(const id of ["a","b","c"]) await db.user.upsert({where:{id:"host-"+id},update:{sessionEpoch:0},create:{id:"host-"+id,accountSub:"usr_host"+id,email:id+"@host-test.invalid",name:"Test "+id,passwordHash:"unusable-test-projection",passwordSet:false,referralCode:"host-"+id,role:"STUDENT"}});
async function token(id="a",key=secret){return new SignJWT({id:"host-"+id,role:"ADMIN",sv:0}).setProtectedHeader({alg:"HS256"}).setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(key));}
const good=await token();
const cookie=t=>({cookie:"yyds_session="+t});
let logs="";
const server=spawn("node_modules/.bin/next",["start","--hostname","127.0.0.1","--port",String(port)],{cwd:dir,env,stdio:["ignore","pipe","pipe"]});
server.stdout.on("data",b=>{logs+=b;});server.stderr.on("data",b=>{logs+=b;});
let count=0;
async function check(path,init){return fetch(origin+path,{redirect:"manual",...init});}
try{
 let ready=false;
 for(let n=0;n<100;n++){try{const r=await check("/api/health");if(r.ok){const b=await r.json();assert.equal(b.service,repo);ready=true;count++;break;}}catch{} await delay(100);}
 assert(ready,"server did not become ready");
 assert.equal((await (await check("/api/auth/session")).json()).user,null);count++;
 assert.equal((await (await check("/api/auth/session",{headers:cookie("invalid")})).json()).user,null);count++;
 assert.equal((await (await check("/api/auth/session",{headers:cookie(await token("a","another-product-test-only-key"))})).json()).user,null);count++;
 assert.equal((await (await check("/api/auth/session",{headers:cookie(good)})).json()).user.accountSub,"usr_hosta");count++;
 if(repo==="mathcode"){
  assert.equal((await check("/api/mathcode/access",{method:"POST",headers:{"content-type":"application/json"},body:'{"pageCount":1}'})).status,401);count++;
  const r=await check("/api/mathcode/access",{headers:cookie(good)});assert.equal(r.status,200);assert.equal((await r.json()).unlimited,false);count++;
 }
 if(repo==="kemiaodoc"){
  assert.equal((await check("/api/docs")).status,401);count++;
  const r=await check("/api/docs",{method:"POST",headers:{...cookie(good),"content-type":"application/json"},body:'{"title":"Host validation"}'});assert.equal(r.status,200);const doc=await r.json();assert(doc.id);count++;
  assert.equal((await check("/api/docs/"+doc.id,{headers:cookie(await token("b"))})).status,404);count++;
  const saved=await check("/api/docs/"+doc.id,{method:"PATCH",headers:{...cookie(good),"content-type":"application/json"},body:JSON.stringify({title:"Saved validation",baseUpdatedAt:doc.updatedAt})});assert.equal(saved.status,200);assert.equal((await saved.json()).title,"Saved validation");count++;
  const shareResponse=await check("/api/docs/shares",{method:"POST",headers:{...cookie(good),"content-type":"application/json"},body:JSON.stringify({scope:"document",documentId:doc.id})});assert.equal(shareResponse.status,200);const share=await shareResponse.json();assert(share.token);count++;
  const publicResponse=await check("/api/docs/public/"+share.token);assert.equal(publicResponse.status,200);assert.equal((await publicResponse.json()).document.id,doc.id);count++;
  const revoke=await check("/api/docs/shares",{method:"PATCH",headers:{...cookie(good),"content-type":"application/json"},body:JSON.stringify({id:share.id,action:"revoke"})});assert.equal(revoke.status,200);assert.equal((await check("/api/docs/public/"+share.token)).status,404);count++;
 }
 if(repo==="meetup"){
  assert.equal((await check("/api/meetup/host-meetup/join",{method:"POST"})).status,401);count++;
  await db.meetup.deleteMany({where:{id:"host-meetup"}});
  await db.meetup.create({data:{id:"host-meetup",title:"Host validation",startsAt:new Date(Date.now()+86400000),place:"Local only",maxPeople:1n,hostId:"host-a"}});
  const join=t=>check("/api/meetup/host-meetup/join",{method:"POST",headers:{...cookie(t),"content-type":"application/json"},body:"{}"});
  assert.equal((await join(await token("b"))).status,200);count++;
  assert.equal((await join(await token("b"))).status,400);count++;
  assert.equal((await join(await token("c"))).status,400);assert.equal(await db.meetupJoin.count({where:{meetupId:"host-meetup"}}),1);count++;
 }
 if(repo==="yydscompanyintroduction"){
  const r=await check("/api/studio/wechat-mp",{headers:cookie(good)});assert.equal(r.status,403);count++;
 }
 assert.equal((await check("/api/auth/logout",{method:"POST",headers:cookie(good)})).status,303);count++;
 assert.equal((await (await check("/api/auth/session",{headers:cookie(good)})).json()).user,null);count++;
 console.log(JSON.stringify({repo,checks:count,result:"PASS",details:"health, auth rejection, product secret isolation, local identity projection, product access boundaries, logout replay rejection"}));
}catch(e){console.error(logs.slice(-8000));throw e;}finally{server.kill("SIGTERM");await new Promise(resolve=>server.once("exit",resolve));await db.$disconnect();}
