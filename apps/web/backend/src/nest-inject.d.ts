import "@nestjs/common";

declare module "@nestjs/common" {
  // Nest 9.0.0 supports constructor parameters at runtime, but its declaration
  // omits their undefined property key. Match the legacy decorator signatures
  // checked by TypeScript 5 without changing the decorator or dependency version.
  function Inject<T = unknown>(token?: T): PropertyDecorator & ParameterDecorator;
}
