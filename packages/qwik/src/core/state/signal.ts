import { assertEqual } from '../error/assert';
import { tryGetInvokeContext } from '../use/use-core';
import { logWarn } from '../util/log';
import { ComputedEvent, RenderEvent, ResourceEvent } from '../util/markers';
import { qDev, qSerialize } from '../util/qdev';
import { isObject } from '../util/types';
import { DerivedSignal2, isSignal2 } from '../v2/signal/v2-signal';
import { getStoreTarget2 } from '../v2/signal/v2-store';
import {
  LocalSubscriptionManager,
  getSubscriptionManager,
  verifySerializable,
  type Subscriber,
  type SubscriptionManager,
  type Subscriptions
} from './common';
import { QObjectManagerSymbol, _CONST_PROPS } from './constants';

/** @public */
export interface Signal<T = any> {
  value: T;
}

/** @public */
export type ReadonlySignal<T = unknown> = Readonly<Signal<T>>;

/** @public */
export type ValueOrSignal<T> = T | Signal<T>;

/** @internal */
export const _createSignal = <T>(
  value: T,
  subsManager: SubscriptionManager,
  flags: number,
  subscriptions?: Subscriptions[]
): SignalInternal<T> => {
  const manager = subsManager.$createManager$(subscriptions);
  const signal = new SignalImpl<T>(value, manager, flags);
  return signal;
};

export const QObjectSignalFlags = Symbol('proxy manager');

export const SIGNAL_IMMUTABLE = 1 << 0;
export const SIGNAL_UNASSIGNED = 1 << 1;

export const SignalUnassignedException = Symbol('unassigned signal');

export interface SignalInternal<T> extends Signal<T> {
  untrackedValue: T;
  [QObjectManagerSymbol]: LocalSubscriptionManager;
  [QObjectSignalFlags]: number;
}

export class SignalBase {}

export class SignalImpl<T> extends SignalBase implements Signal<T> {
  untrackedValue: T;
  [QObjectManagerSymbol]: LocalSubscriptionManager;
  [QObjectSignalFlags]: number = 0;

  constructor(v: T, manager: LocalSubscriptionManager, flags: number) {
    super();
    this.untrackedValue = v;
    this[QObjectManagerSymbol] = manager;
    this[QObjectSignalFlags] = flags;
  }

  // prevent accidental use as value
  valueOf() {
    if (qDev) {
      throw new TypeError('Cannot coerce a Signal, use `.value` instead');
    }
  }
  toString() {
    return `[Signal ${String(this.value)}]`;
  }
  toJSON() {
    return { value: this.value };
  }

  get value() {
    if (this[QObjectSignalFlags] & SIGNAL_UNASSIGNED) {
      throw SignalUnassignedException;
    }
    const sub = tryGetInvokeContext()?.$subscriber$;
    if (sub) {
      this[QObjectManagerSymbol].$addSub$(sub);
    }
    return this.untrackedValue;
  }

  set value(v: T) {
    if (qDev) {
      if (this[QObjectSignalFlags] & SIGNAL_IMMUTABLE) {
        throw new Error('Cannot mutate immutable signal');
      }
      if (qSerialize) {
        verifySerializable(v);
      }
      const invokeCtx = tryGetInvokeContext();
      if (invokeCtx) {
        if (invokeCtx.$event$ === RenderEvent) {
          logWarn(
            'State mutation inside render function. Use useTask$() instead.',
            invokeCtx.$hostElement$
          );
        } else if (invokeCtx.$event$ === ComputedEvent) {
          logWarn(
            'State mutation inside useComputed$() is an antipattern. Use useTask$() instead',
            invokeCtx.$hostElement$
          );
        } else if (invokeCtx.$event$ === ResourceEvent) {
          logWarn(
            'State mutation inside useResource$() is an antipattern. Use useTask$() instead',
            invokeCtx.$hostElement$
          );
        }
      }
    }
    const manager = this[QObjectManagerSymbol];
    const oldValue = this.untrackedValue;
    if (manager && oldValue !== v) {
      this.untrackedValue = v;
      manager.$notifySubs$();
    }
  }
}

export class SignalDerived<RETURN = unknown, ARGS extends any[] = unknown[]> extends SignalBase {
  constructor(
    public $func$: (...args: ARGS) => RETURN,
    public $args$: ARGS,
    public $funcStr$?: string
  ) {
    super();
  }

  get value(): RETURN {
    return this.$func$.apply(undefined, this.$args$);
  }
  get [QObjectManagerSymbol]() {
    const args = this.$args$;
    if (args?.length >= 2 && typeof args[0] === 'object' && typeof args[1] === 'string') {
      const subMgr = getSubscriptionManager(args[0]);
      if (subMgr) {
        return new DerivedSubscriptionManager(subMgr, args[1]);
      }
    }
    return undefined;
  }
}

const notImplemented = () => {
  throw new Error();
};
class DerivedSubscriptionManager implements Omit<LocalSubscriptionManager, '$subs$'> {
  constructor(
    private $delegate$: LocalSubscriptionManager,
    private $prop$: string
  ) {}
  $addSub$(sub: Subscriber, key?: string | undefined): void {
    this.$delegate$.$addSub$(sub, this.$prop$);
  }
  $addSubs$ = notImplemented;
  $addToGroup$ = notImplemented;
  $unsubGroup$ = notImplemented;
  $unsubEntry$ = notImplemented;
  $notifySubs$ = notImplemented;
}

export class SignalWrapper<T extends Record<string, any>, P extends keyof T> extends SignalBase {
  constructor(
    public ref: T,
    public prop: P
  ) {
    super();
  }

  get [QObjectManagerSymbol]() {
    return getSubscriptionManager(this.ref);
  }

  get value(): T[P] {
    return this.ref[this.prop];
  }

  set value(value: T[P]) {
    this.ref[this.prop] = value;
  }
}

/**
 * Checks if a given object is a `Signal`.
 *
 * @param obj - The object to check if `Signal`.
 * @returns Boolean - True if the object is a `Signal`.
 * @public
 */
export const isSignal = <T = unknown>(obj: any): obj is Signal<T> => {
  return obj instanceof SignalBase;
};

const getProp = (obj: any, prop: string) => obj[prop];

/** @internal */
export const _wrapProp = <T extends Record<any, any>, P extends keyof T>(obj: T, prop: P): any => {
  if (!isObject(obj)) {
    return obj[prop];
  }
  if (isSignal2(obj)) {
    assertEqual(prop, 'value', 'Left side is a signal, prop must be value');
    return new DerivedSignal2(null, getProp, [obj, prop as string], null);
  }
  if (_CONST_PROPS in obj) {
    const constProps = (obj as any)[_CONST_PROPS];
    if (constProps && prop in constProps) {
      // Const props don't need wrapping
      return constProps[prop];
    }
  } else {
    const target = getStoreTarget2(obj);
    if (target) {
      const signal = target[prop];
      const wrappedValue = isSignal2(signal) ? signal : new DerivedSignal2(null, getProp, [obj, prop as string], null);
      return wrappedValue
    }
  }
  // We need to forward the access to the original object
  return new DerivedSignal2(null, getProp, [obj, prop as string], null);
};
