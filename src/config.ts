export const W = 720;
export const H = 1120;
export const GOAL = 250;
export const PUCK_R = 24;
export const MALLET_R = 48;
export const reducedEffects = matchMedia("(pointer: coarse)").matches || (navigator.hardwareConcurrency ?? 8) <= 4;
export const renderScale = reducedEffects ? .5 : 1;
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
