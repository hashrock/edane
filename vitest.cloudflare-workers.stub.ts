// `cloudflare:workers` only exists in workerd. Node tests that import server.ts
// (app/routePolicy.test.ts) only need the class to extend; nothing runs it.
export class DurableObject {
  constructor(
    readonly ctx: unknown,
    readonly env: unknown
  ) {}
}
