import { z } from "zod";

export const protocolVersion = 1;

export const ProtocolVersion = z.literal(protocolVersion);

export type ProtocolVersion = z.infer<typeof ProtocolVersion>;
