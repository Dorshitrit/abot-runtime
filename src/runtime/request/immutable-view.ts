/** Builds a frozen getter-backed view without copying its source values. */
export function createFrozenSurface<T>(descriptors: PropertyDescriptorMap): T {
  return Object.freeze(Object.defineProperties({}, descriptors)) as T;
}

export function enumerableGetter<T>(get: () => T): PropertyDescriptor {
  return Object.freeze({ enumerable: true, get });
}

export function hiddenValue<T>(value: T): PropertyDescriptor {
  return Object.freeze({ enumerable: false, value });
}
