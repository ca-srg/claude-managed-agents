declare module "bun:test" {
  type Awaitable = void | Promise<void>;
  type TestCallback = () => Awaitable;

  interface Assertion<TValue> {
    readonly not: Assertion<TValue>;
    readonly rejects: Assertion<unknown>;
    readonly resolves: Assertion<Awaited<TValue>>;
    toBe(expected: unknown): void;
    toBeDefined(): void;
    toBeInstanceOf(expected: new (...args: unknown[]) => unknown): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toContain(expected: string): void;
    toContainEqual(expected: unknown): void;
    toEqual(expected: unknown): void;
    toHaveLength(expected: number): void;
    toMatch(expected: RegExp | string): void;
    toMatchObject(expected: Record<string, unknown>): void;
    toThrow(expected?: string | RegExp | Error): void;
  }

  function afterAll(fn: TestCallback, timeout?: number): void;
  function afterEach(fn: TestCallback): void;
  function beforeAll(fn: TestCallback, timeout?: number): void;
  function describe(name: string, fn: TestCallback): void;
  function expect<TValue>(actual: TValue): Assertion<TValue>;

  namespace expect {
    function objectContaining(expected: Record<string, unknown>): unknown;
    function stringMatching(expected: RegExp | string): unknown;
  }

  function it(name: string, fn: TestCallback, timeout?: number): void;
  function test(name: string, fn: TestCallback, timeout?: number): void;
}
