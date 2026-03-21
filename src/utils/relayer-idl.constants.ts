import { IDL } from "../interfaces/idls/base-relayer.idl";
import { createIdlConstantGetter } from "./idl-constants";

export const getRelayerIdlConstant = createIdlConstantGetter(IDL.constants);
