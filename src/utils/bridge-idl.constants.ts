import { IDL } from "../interfaces/idls/bridge.idl";
import { createIdlConstantGetter } from "./idl-constants";

export const getIdlConstant = createIdlConstantGetter(IDL.constants);
