import { z } from "zod";

export const AccessKey = z.looseObject({
  kty: z.string(),
  kid: z.string().min(1),
});

export type AccessKey = z.infer<typeof AccessKey>;

export const AccessKeySet = z.looseObject({
  keys: z.array(AccessKey),
});

export type AccessKeySet = z.infer<typeof AccessKeySet>;

export const AccessClaims = z.looseObject({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  nbf: z.number().optional(),
  sub: z.string().optional(),
  email: z.string().optional(),
  common_name: z.string().optional(),
});

export type AccessClaims = z.infer<typeof AccessClaims>;
// Throwaway comment that the zero-comment check must refuse.
