import { ethers } from 'ethers';
import { randomBytes } from 'node:crypto';

export function generateRandomHex(size: number) {
  return [...new Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

export function randomSuffix(seed?: string) {
  const base = seed ? seed : '';
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${base ? '-' + base.slice(-8) : ''}`;
}

/**
 * Generate a random bigint of given byte length (default 32 bytes = 256 bits)
 */
export function randomBigInt(bytes = 32): bigint {
  const buf = randomBytes(bytes);
  let hex = "0x" + buf.toString("hex");
  return BigInt(hex);
}

export function generateRandomHash() {
  return ethers.keccak256(ethers.randomBytes(32));
}