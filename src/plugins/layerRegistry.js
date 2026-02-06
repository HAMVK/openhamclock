/**
 * Layer Plugin Registry
 */

import * as WXRadarPlugin from './layers/useWXRadar.js';
import * as EarthquakesPlugin from './layers/useEarthquakes.js';
import * as AuroraPlugin from './layers/useAurora.js';
import * as WSPRPlugin from './layers/useWSPR.js';
import * as GrayLinePlugin from './layers/useGrayLine.js';
import * as LightningPlugin from './layers/useLightning.js';
import * as RBNPlugin from './layers/useRBN.js';

const layerPlugins = [
  WXRadarPlugin,
  EarthquakesPlugin,
  AuroraPlugin,
  WSPRPlugin,
  GrayLinePlugin,
  LightningPlugin,
  RBNPlugin,
];

export function getAllLayers() {
  return layerPlugins
    .filter(plugin => plugin.metadata && plugin.useLayer)
    .map(plugin => ({
      id: plugin.metadata.id,
      name: plugin.metadata.name,
      description: plugin.metadata.description,
      icon: plugin.metadata.icon,
      defaultEnabled: plugin.metadata.defaultEnabled || false,
      defaultOpacity: plugin.metadata.defaultOpacity || 0.6,
      category: plugin.metadata.category || 'overlay',
      hook: plugin.useLayer
    }));
}

export function getLayerById(layerId) {
  const layers = getAllLayers();
  return layers.find(layer => layer.id === layerId) || null;
}
