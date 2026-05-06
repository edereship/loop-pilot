export interface AuthorizationHeader {
  scheme: "Bearer";
  value: string;
}

export function buildAuthorizationHeader(token: string): AuthorizationHeader {
  return {
    scheme: "Bearer",
    value: token,
  };
}
