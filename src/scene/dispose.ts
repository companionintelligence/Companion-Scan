/**
 * Frees what a three.js subtree holds on the GPU: every geometry and every material under `root`, the root included
 * (wave 14, ticket 0004; F-40, FN-037). The calibration modal (src/ar/project-calibration.ts) and the constellation ghosts
 * (src/ar/constellation-ghosts.ts) each wrote this traversal out. It does not detach `root` from its parent, and it does
 * not dispose textures: nothing these callers draw has one.
 */
import type * as THREE from 'three'

export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((child) => {
    const drawable = child as Partial<THREE.Mesh>
    drawable.geometry?.dispose()
    const material = drawable.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
}
