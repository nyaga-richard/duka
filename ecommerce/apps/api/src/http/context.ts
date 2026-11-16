import type { NextFunction, Request, Response } from "express";
import type { Database, Transaction } from "../db/index.ts";
import type { Permission } from "@ecom/shared";

export interface CustomerActor {
  kind: "customer";
  customerId: number;
  sessionId: string;
  email: string;
  firstName: string;
  lastName: string;
  csrf: string;
}

export interface GuestActor {
  kind: "guest";
  guestSessionId: string;
  sessionId: string;
  email: string | null;
  csrf: string;
}

export interface AdminActor {
  kind: "admin";
  adminUserId: string;
  sessionId: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: Permission[];
  csrf: string;
}

export type Actor = CustomerActor | GuestActor | AdminActor;

export interface RequestContext {
  req: Request;
  res: Response;
  db: Database;
  requestId: string;
  ip: string;
  actor: Actor | null;
  startedAt: number;
}

export type Handler = (ctx: RequestContext) => Promise<unknown>;
export type Middleware = (req: Request, res: Response, next: NextFunction) => void;
