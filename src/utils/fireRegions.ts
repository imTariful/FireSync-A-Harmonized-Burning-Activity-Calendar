/**
 * Global Fire Regimes (NASA biomes) driving the preset area selection.
 * Categorized by the 5 primary fire biomes recognized by NASA FIRMS & global fire science.
 * Chips become an `Area` through utils/area.ts.
 */

import { BoundingBox } from '../types/fire';

export type FireBiomeId = 'savanna' | 'tropical' | 'boreal' | 'mediterranean' | 'agricultural';

export interface QuickRegion {
  id: string;
  name: string;
  bbox: BoundingBox;
  biome: FireBiomeId;
  group?: 'study' | 'big-fire';
}

export interface FireBiomeGroup {
  id: FireBiomeId;
  title: string;
  icon: string;
  tag: string;
  regions: QuickRegion[];
}

export const FIRE_BIOME_GROUPS: FireBiomeGroup[] = [
  {
    id: 'savanna',
    title: 'Savanna & Grasslands',
    icon: '🌾',
    tag: 'Highest Fire Counts',
    regions: [
      {
        id: 'central_africa',
        name: 'Central Africa (Savanna)',
        bbox: { west: 10, south: -14, east: 38, north: 8 },
        biome: 'savanna',
        group: 'big-fire',
      },
      {
        id: 'eastern_australia',
        name: 'Eastern Australia (Bushfire Belt)',
        bbox: { west: 140, south: -39, east: 154, north: -24 },
        biome: 'savanna',
        group: 'big-fire',
      },
    ],
  },
  {
    id: 'tropical',
    title: 'Tropical Deforestation',
    icon: '🌴',
    tag: 'Rainforest Clearing',
    regions: [
      {
        id: 'amazon_arc',
        name: 'Amazon Arc of Deforestation',
        bbox: { west: -66.0, south: -15.0, east: -48.0, north: -3.0 },
        biome: 'tropical',
        group: 'study',
      },
    ],
  },
  {
    id: 'boreal',
    title: 'Boreal Forests & Taiga',
    icon: '🌲',
    tag: 'High Latitude Megafires',
    regions: [
      {
        id: 'canada_boreal',
        name: 'Canada (Boreal Forest)',
        bbox: { west: -128, south: 49, east: -92, north: 62 },
        biome: 'boreal',
        group: 'big-fire',
      },
      {
        id: 'siberia',
        name: 'Siberia Taiga (Russia)',
        bbox: { west: 100, south: 52, east: 140, north: 66 },
        biome: 'boreal',
        group: 'big-fire',
      },
    ],
  },
  {
    id: 'mediterranean',
    title: 'Temperate & Mediterranean',
    icon: '☀️',
    tag: 'Seasonal Wildfires',
    regions: [
      {
        id: 'california',
        name: 'California / US West',
        bbox: { west: -124.5, south: 32.5, east: -114.1, north: 42.0 },
        biome: 'mediterranean',
        group: 'study',
      },
      {
        id: 'mediterranean',
        name: 'Mediterranean Europe',
        bbox: { west: -10, south: 34, east: 30, north: 46 },
        biome: 'mediterranean',
        group: 'big-fire',
      },
    ],
  },
  {
    id: 'agricultural',
    title: 'Agricultural Biomass Burning',
    icon: '🚜',
    tag: 'Seasonal Crop Residue',
    regions: [
      {
        id: 'indochina',
        name: 'Southeast Asia (Indochina)',
        bbox: { west: 92.0, south: 9.0, east: 109.5, north: 28.5 },
        biome: 'agricultural',
        group: 'study',
      },
    ],
  },
];

/** Flat list of all 8 global preset regions */
export const QUICK_REGIONS: QuickRegion[] = FIRE_BIOME_GROUPS.flatMap((g) => g.regions);
