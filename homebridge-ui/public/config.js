/** Merge onboarding into existing configuration without dropping advanced settings. */
export function mergeDevices(configBlocks, imported) {
  const blocks = [...configBlocks];
  let index = blocks.findIndex((block) => block.platform === 'XiaomiMiot');
  if (index < 0) {
    index = blocks.length;
    blocks.push({ platform: 'XiaomiMiot', name: 'Xiaomi MIoT', pollInterval: 15, devices: [] });
  }
  const config = blocks[index];
  const devices = Array.isArray(config.devices) ? config.devices.map((device) => ({ ...device })) : [];
  for (const incoming of imported) {
    const existingIndex = devices.findIndex((device) =>
      (incoming.did && device.did === incoming.did)
      || (!device.did && device.host === incoming.host));
    if (existingIndex === -1) {
      devices.push({ ...incoming });
    } else {
      const existing = devices[existingIndex];
      devices[existingIndex] = {
        ...existing,
        ...incoming,
        name: existing.name || incoming.name,
        enabled: existing.enabled ?? incoming.enabled,
      };
    }
  }
  blocks[index] = { ...config, devices };
  return blocks;
}
