import { z } from "zod";
import { CommandOutput, CommandUpdate } from "./commands.js";
import { ProtocolVersion } from "./version.js";

export const PersonIdentity = z.object({
  kind: z.literal("person"),
  email: z.email(),
  subject: z.string().min(1),
});

export type PersonIdentity = z.infer<typeof PersonIdentity>;

export const ServiceIdentity = z.object({
  kind: z.literal("service"),
  clientId: z.string().min(1),
});

export type ServiceIdentity = z.infer<typeof ServiceIdentity>;

export const Identity = z.discriminatedUnion("kind", [PersonIdentity, ServiceIdentity]);

export type Identity = z.infer<typeof Identity>;

export const Health = z.object({
  status: z.enum(["ok", "unavailable"]),
});

export type Health = z.infer<typeof Health>;

export const Refusal = z.object({
  error: z.enum(["forbidden", "not_found", "unsupported_media_type"]),
});

export type Refusal = z.infer<typeof Refusal>;

export const Session = z.object({
  protocol: ProtocolVersion,
  identity: Identity,
});

export type Session = z.infer<typeof Session>;

export const Hello = z.object({
  type: z.literal("hello"),
  protocol: ProtocolVersion,
  identity: Identity,
});

export type Hello = z.infer<typeof Hello>;

export const ServerMessage = z.discriminatedUnion("type", [Hello, CommandUpdate, CommandOutput]);

export type ServerMessage = z.infer<typeof ServerMessage>;
