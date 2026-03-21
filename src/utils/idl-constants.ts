import { type Address, address } from "@solana/kit";

type IdlConstantsArray = ReadonlyArray<{
  name: string;
  type: unknown;
  value: string;
}>;

type IdlConstant<
  T extends IdlConstantsArray,
  Name extends T[number]["name"],
> = Extract<T[number], { name: Name }>;

type IdlConstantField<
  T extends IdlConstantsArray,
  Name extends T[number]["name"],
  Field extends keyof IdlConstant<T, Name> = "value",
> = IdlConstant<T, Name>[Field];

type ParsedConstantValue<
  T extends IdlConstantsArray,
  Name extends T[number]["name"],
> =
  IdlConstantField<T, Name, "type"> extends "pubkey"
    ? Address
    : IdlConstantField<T, Name, "type"> extends "u128" | "u64"
      ? bigint
      : IdlConstantField<T, Name, "type"> extends "u16" | "u8"
        ? number
        : IdlConstantField<T, Name, "type"> extends "bytes"
          ? number[]
          : IdlConstantField<T, Name, "type"> extends { array: unknown }
            ? number[]
            : IdlConstantField<T, Name, "type"> extends "string"
              ? string
              : never;

export function createIdlConstantGetter<const T extends IdlConstantsArray>(
  constants: T,
) {
  const cache = new Map<string, unknown>();

  return <Name extends T[number]["name"]>(
    name: Name,
  ): ParsedConstantValue<T, Name> => {
    if (cache.has(name)) {
      return cache.get(name) as ParsedConstantValue<T, Name>;
    }

    const constant = constants.find((c) => c.name === name);
    if (!constant) {
      throw new Error(`Constant "${name}" not found`);
    }
    const { type, value } = constant;

    let result: unknown;

    if (typeof type === "object" && type !== null && "array" in type) {
      result = JSON.parse(value);
    } else {
      switch (type) {
        case "pubkey":
          result = address(value);
          break;
        case "string":
        case "bytes":
          result = JSON.parse(value);
          break;
        case "u128":
        case "u64":
          result = BigInt(value);
          break;
        case "u16":
        case "u8":
          result = Number(value);
          break;
        default:
          throw new Error(
            `Unsupported IDL constant type: ${JSON.stringify(type)}`,
          );
      }
    }

    cache.set(name, result);
    return result as ParsedConstantValue<T, Name>;
  };
}
