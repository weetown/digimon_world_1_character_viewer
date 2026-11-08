// Byte-exact slices of the game data for the archive, plus a JSON of the parsed animations.

import { MMDS } from "../data/mmds";
import { ALLTIM } from "../data/tims";
import { NODES, BABY_NODES } from "../data/nodes";
import { DIGIMONS } from "../data/digimons";
import { Mmd } from "../structs/mmd";
import { NodeStructData } from "../structs/node_struct";
import { DigimonStructData } from "../structs/digimon_struct";
import { FIRST_SKELETON_POINTER } from "../structs/skeleton_pointer";
import { PSX_MEMORY_SPACE_POINTER } from "../constants";
import { AnimationFixes } from "./clip-baker";

const TIM_BYTE_LENGTH = 0x4800;
const DIGIMON_STRUCT_BYTE_LENGTH = 52; // 20 name + 4 + 2 + 2 + 1 + 1 + 22 skipped

export interface RawDump {
  "raw/mmd.bin": Uint8Array;
  "raw/tmd.bin": Uint8Array;
  "raw/tim.bin": Uint8Array;
  "raw/nodes.bin": Uint8Array;
  "raw/digimon_struct.bin": Uint8Array;
  "raw/animations.json": Uint8Array;
}

function pick<T extends object>(object: T, keys: Array<keyof T>) {
  const out: Record<string, unknown> = {};
  keys.forEach((key) => {
    out[key as string] = object[key];
  });
  return out;
}

const DIGIMON_STRUCT_KEYS: Array<keyof DigimonStructData> = [
  "numberOfNodes",
  "radius",
  "height",
  "type",
  "level",
];

const POSTURE_KEYS = [
  "scaleX",
  "scaleY",
  "scaleZ",
  "rotationX",
  "rotationY",
  "rotationZ",
  "positionX",
  "positionY",
  "positionZ",
];

export function dumpRaw({
  index,
  mmd,
  nodeStructs,
  skeletonPointer,
  digimonStruct,
  name,
  fixes,
}: {
  index: number;
  mmd: Mmd;
  nodeStructs: NodeStructData[];
  skeletonPointer: number;
  digimonStruct: DigimonStructData;
  name: string;
  fixes: Record<number, AnimationFixes>;
}): RawDump {
  const mmdBytes = new Uint8Array(MMDS(index));

  const tmdBytes = mmdBytes.slice(mmd.tmdPointer, mmd.animationOffsetsPointer);

  const timBytes = new Uint8Array(
    ALLTIM().slice(index * TIM_BYTE_LENGTH, (index + 1) * TIM_BYTE_LENGTH),
  );

  const nodesOffset = skeletonPointer - PSX_MEMORY_SPACE_POINTER - FIRST_SKELETON_POINTER;
  const isBaby = nodesOffset > NODES().byteLength;
  const nodesBytes = new Uint8Array(
    (isBaby ? BABY_NODES() : NODES()).slice(
      isBaby ? 0 : nodesOffset,
      (isBaby ? 0 : nodesOffset) + nodeStructs.length * 2,
    ),
  );

  const digimonStructBytes = new Uint8Array(
    DIGIMONS().slice(
      index * DIGIMON_STRUCT_BYTE_LENGTH,
      (index + 1) * DIGIMON_STRUCT_BYTE_LENGTH,
    ),
  );

  const animations = mmd.animations.map((animation, animationIndex) => {
    if (!animation) return null;

    return {
      index: animationIndex,
      offset: mmd.animationOffsets[animationIndex],
      pose: {
        numberOfSequences: animation.pose.numberOfSequences,
        hasScale: animation.pose.hasScale === 128,
        postures: animation.pose.postureStructs.map((posture) =>
          pick(posture as unknown as Record<string, unknown>, POSTURE_KEYS as never[]),
        ),
      },
      sequences: animation.sequences.map((sequence) => {
        if (sequence.opcode === 0) {
          return {
            opcode: 0,
            sequenceIndex: sequence.sequenceIndex,
            keyframes: sequence.keyframes.map((keyframe) => ({ ...keyframe })),
          };
        }
        return { ...sequence };
      }),
    };
  });

  const json = {
    game: "Digimon World (PSX, USA)",
    digimonIndex: index,
    name,
    units: {
      rotation: "value * PI / 2048 radians",
      scale: "value / 4096",
      position: "raw game units",
      time: "duration units; see timeUnitSeconds in the glb extras",
    },
    digimonStruct: pick(digimonStruct, DIGIMON_STRUCT_KEYS),
    skeletonPointer,
    nodeStructs: nodeStructs.map((node) => ({
      objectIndex: node.objectIndex,
      nodeIndex: node.nodeIndex,
    })),
    mmd: {
      tmdPointer: mmd.tmdPointer,
      animationOffsetsPointer: mmd.animationOffsetsPointer,
      animationOffsets: mmd.animationOffsets,
    },
    fixesApplied: fixes,
    animations,
  };

  return {
    "raw/mmd.bin": mmdBytes,
    "raw/tmd.bin": tmdBytes,
    "raw/tim.bin": timBytes,
    "raw/nodes.bin": nodesBytes,
    "raw/digimon_struct.bin": digimonStructBytes,
    "raw/animations.json": new TextEncoder().encode(JSON.stringify(json, null, 2)),
  };
}
