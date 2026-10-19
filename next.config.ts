import type {NextConfig} from "next";
import {securityHeaders} from "@andyyyds/shared/security/headers";
const config:NextConfig={transpilePackages:["@yydsxwh/shared","@andyyyds/meetup","@andyyyds/shared","@andyyyds/courses","@andyyyds/decorate","@andyyyds/mathcode","@andyyyds/forum"],async headers(){return [{source:"/:path*",headers:securityHeaders()}];}};
export default config;
