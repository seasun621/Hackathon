import itemCsv from '../data/items.csv?raw';

export type ItemCategory = 'passive' | 'attack' | 'equipment';
export type ItemSlot = 'none' | 'primary' | 'secondary' | 'equipment';

export interface ItemDefinition {
  id: string;
  name: string;
  category: ItemCategory;
  slot: ItemSlot;
  description: string;
  maxLevel: number;
  primaryBase: number;
  primaryGrowth: number;
  secondaryBase: number;
  secondaryGrowth: number;
  color: string;
  model: string;
}

export interface ItemOffer {
  definition: ItemDefinition;
  currentLevel: number;
  nextLevel: number;
  status: 'NEW' | 'UPGRADE' | 'REPLACE' | 'CONSUME';
  replacedItem?: ItemDefinition;
}

export interface ItemApplyResult {
  definition: ItemDefinition;
  level: number;
  instantHeal: number;
  instantMaxHealth: number;
  replacedItem?: ItemDefinition;
}

export interface OwnedItem {
  definition: ItemDefinition;
  level: number;
  equipped: boolean;
}

export interface WeaponStats {
  id: string;
  level: number;
  damage: number;
  cooldown: number;
  range: number;
}

export interface ItemStatComparison {
  label: string;
  current: number;
  next: number;
  max: number;
  unit: string;
  decimals?: number;
  lowerIsBetter?: boolean;
  loss?: boolean;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

function parseDefinitions(csv: string): ItemDefinition[] {
  const rows = csv.trim().split(/\r?\n/).filter(Boolean);
  return rows.slice(1).map((row) => {
    const [
      id,
      name,
      category,
      slot,
      description,
      maxLevel,
      primaryBase,
      primaryGrowth,
      secondaryBase,
      secondaryGrowth,
      color,
      model,
    ] = parseCsvLine(row);
    return {
      id,
      name,
      category: category as ItemCategory,
      slot: slot as ItemSlot,
      description,
      maxLevel: Number(maxLevel),
      primaryBase: Number(primaryBase),
      primaryGrowth: Number(primaryGrowth),
      secondaryBase: Number(secondaryBase),
      secondaryGrowth: Number(secondaryGrowth),
      color,
      model,
    };
  });
}

export class ItemSystem {
  private readonly definitions = parseDefinitions(itemCsv);
  private readonly definitionMap = new Map(this.definitions.map((item) => [item.id, item]));
  private readonly levels = new Map<string, number>();
  private readonly permanentCounts = new Map<string, number>();
  private primaryId = 'laser';
  private secondaryId: string | null = null;
  private equipmentId: string | null = null;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.levels.clear();
    this.permanentCounts.clear();
    this.primaryId = 'laser';
    this.secondaryId = null;
    this.equipmentId = null;
    this.levels.set('laser', 1);
  }

  getDefinition(id: string | null): ItemDefinition | null {
    if (!id) return null;
    return this.definitionMap.get(id) ?? null;
  }

  rollOffers(count = 3): ItemOffer[] {
    const pool = this.definitions.filter((definition) => {
      if (definition.maxLevel === 0) return true;
      return (this.levels.get(definition.id) ?? 0) < definition.maxLevel;
    });
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
    }
    return pool.slice(0, count).map((definition) => this.createOffer(definition));
  }

  applyOffer(offer: ItemOffer): ItemApplyResult {
    const { definition } = offer;
    if (definition.id === 'instant_heal') {
      return { definition, level: 0, instantHeal: definition.primaryBase, instantMaxHealth: 0 };
    }
    if (definition.id === 'max_health_cell') {
      const nextCount = (this.permanentCounts.get(definition.id) ?? 0) + 1;
      this.permanentCounts.set(definition.id, nextCount);
      return {
        definition,
        level: nextCount,
        instantHeal: definition.primaryBase,
        instantMaxHealth: definition.primaryBase,
      };
    }

    const previousLevel = this.levels.get(definition.id) ?? 0;
    const nextLevel = Math.min(definition.maxLevel, Math.max(1, previousLevel + 1));
    this.levels.set(definition.id, nextLevel);
    let replacedItem: ItemDefinition | undefined;
    if (definition.slot === 'primary' && this.primaryId !== definition.id) {
      replacedItem = this.getDefinition(this.primaryId) ?? undefined;
      this.primaryId = definition.id;
    } else if (definition.slot === 'secondary' && this.secondaryId !== definition.id) {
      replacedItem = this.getDefinition(this.secondaryId) ?? undefined;
      this.secondaryId = definition.id;
    } else if (definition.slot === 'equipment' && this.equipmentId !== definition.id) {
      replacedItem = this.getDefinition(this.equipmentId) ?? undefined;
      this.equipmentId = definition.id;
    }
    return { definition, level: nextLevel, instantHeal: 0, instantMaxHealth: 0, replacedItem };
  }

  getPrimaryStats(): WeaponStats {
    return this.getWeaponStats(this.primaryId);
  }

  getSecondaryStats(): WeaponStats | null {
    return this.secondaryId ? this.getWeaponStats(this.secondaryId) : null;
  }

  getPrimaryId(): string {
    return this.primaryId;
  }

  getSecondaryId(): string | null {
    return this.secondaryId;
  }

  getEquipmentId(): string | null {
    return this.equipmentId;
  }

  getDamageReduction(): number {
    const passive = this.getDamageGuardReduction();
    const armor = this.getArmorDamageReduction();
    return Math.min(0.72, passive + armor);
  }

  getDamageGuardReduction(): number {
    return this.valueAtLevel('damage_guard', 'primary');
  }

  getArmorDamageReduction(): number {
    return this.equipmentId === 'armor' ? this.valueAtLevel('armor', 'secondary') : 0;
  }

  getSpeedMultiplier(): number {
    return 1 + this.getSpeedBonus();
  }

  getSpeedBonus(): number {
    return this.valueAtLevel('speed_boost', 'primary');
  }

  getGravityMultiplier(grappling: boolean): number {
    const passiveReduction = this.getGravityCutReduction();
    const wingReduction = !grappling ? this.getWingsuitGravityReduction() : 0;
    return Math.max(0.48, 1 - passiveReduction - wingReduction);
  }

  getGravityCutReduction(): number {
    return this.valueAtLevel('gravity_cut', 'primary');
  }

  getWingsuitGravityReduction(): number {
    return this.equipmentId === 'wingsuit' ? this.valueAtLevel('wingsuit', 'primary') : 0;
  }

  getDashMultiplier(): number {
    return this.equipmentId === 'jetpack'
      ? 1 + this.valueAtLevel('jetpack', 'primary')
      : 1;
  }

  getBloodSiphonRatio(): number {
    return this.valueAtLevel('blood_siphon', 'primary');
  }

  getEquipmentHealthBonus(): number {
    return this.equipmentId === 'armor' ? this.valueAtLevel('armor', 'primary') : 0;
  }

  getPermanentHealthBonus(): number {
    const item = this.getDefinition('max_health_cell');
    return (this.permanentCounts.get('max_health_cell') ?? 0) * (item?.primaryBase ?? 0);
  }

  getOwnedItems(): OwnedItem[] {
    const owned: OwnedItem[] = [];
    for (const [id, level] of this.levels) {
      const definition = this.getDefinition(id);
      if (!definition) continue;
      const equipped = id === this.primaryId || id === this.secondaryId || id === this.equipmentId;
      if (definition.category === 'passive' || equipped) owned.push({ definition, level, equipped });
    }
    const maxHealthCount = this.permanentCounts.get('max_health_cell') ?? 0;
    const maxHealthDefinition = this.getDefinition('max_health_cell');
    if (maxHealthCount > 0 && maxHealthDefinition) {
      owned.push({ definition: maxHealthDefinition, level: maxHealthCount, equipped: true });
    }
    return owned;
  }

  describeOffer(offer: ItemOffer): string {
    const { definition, currentLevel, nextLevel } = offer;
    if (definition.id === 'instant_heal') return `HP +${definition.primaryBase}`;
    if (definition.id === 'max_health_cell') return `MAX HP +${definition.primaryBase}`;
    const primary = definition.primaryBase + definition.primaryGrowth * Math.max(0, nextLevel - 1);
    const secondary = definition.secondaryBase + definition.secondaryGrowth * Math.max(0, nextLevel - 1);
    const currentPrimary = definition.primaryBase + definition.primaryGrowth * Math.max(0, currentLevel - 1);
    const currentSecondary = definition.secondaryBase + definition.secondaryGrowth * Math.max(0, currentLevel - 1);
    const numberProgress = (current: number | string, next: number | string, suffix = ''): string => currentLevel > 0
      ? `${current}${suffix} > ${next}${suffix}`
      : `${next}${suffix}`;
    if (definition.slot === 'primary' || definition.slot === 'secondary') {
      const currentRange = this.getWeaponRange(definition.id, Math.max(1, currentLevel));
      const nextRange = this.getWeaponRange(definition.id, nextLevel);
      return `DAMAGE ${numberProgress(Math.round(currentPrimary), Math.round(primary))} · DELAY ${numberProgress(Math.max(0.04, currentSecondary).toFixed(2), Math.max(0.04, secondary).toFixed(2), 's')} · RANGE ${numberProgress(Math.round(currentRange), Math.round(nextRange), 'm')}`;
    }
    if (definition.id === 'damage_guard') return `INCOMING DAMAGE -${numberProgress(Math.round(currentPrimary * 100), Math.round(primary * 100), '%')}`;
    if (definition.id === 'speed_boost') return `MOVE SPEED +${numberProgress(Math.round(currentPrimary * 100), Math.round(primary * 100), '%')}`;
    if (definition.id === 'gravity_cut') return `GRAVITY -${numberProgress(Math.round(currentPrimary * 100), Math.round(primary * 100), '%')}`;
    if (definition.id === 'blood_siphon') return `DAMAGE SIPHON ${numberProgress(Math.round(currentPrimary * 100), Math.round(primary * 100), '%')}`;
    if (definition.id === 'jetpack') return `DASH POWER +${numberProgress(Math.round(currentPrimary * 100), Math.round(primary * 100), '%')}`;
    if (definition.id === 'wingsuit') return `GLIDE GRAVITY -${numberProgress(Math.round(currentPrimary * 100), Math.round(primary * 100), '%')}`;
    if (definition.id === 'armor') {
      return `MAX HP +${numberProgress(Math.round(currentPrimary), Math.round(primary))} · DAMAGE -${numberProgress(Math.round(currentSecondary * 100), Math.round(secondary * 100), '%')}`;
    }
    return `LEVEL ${nextLevel}`;
  }

  getOfferStatComparisons(offer: ItemOffer): ItemStatComparison[] {
    const { definition, currentLevel, nextLevel } = offer;
    const primary = this.definitionValue(definition, nextLevel, 'primary');
    const secondary = this.definitionValue(definition, nextLevel, 'secondary');
    const currentPrimary = currentLevel > 0 && !offer.replacedItem
      ? this.definitionValue(definition, currentLevel, 'primary')
      : 0;
    const currentSecondary = currentLevel > 0 && !offer.replacedItem
      ? this.definitionValue(definition, currentLevel, 'secondary')
      : 0;
    const maxLevel = Math.max(1, definition.maxLevel);
    const maxPrimary = this.definitionValue(definition, maxLevel, 'primary');
    const maxSecondary = this.definitionValue(definition, maxLevel, 'secondary');
    let rows: ItemStatComparison[] = [];

    if (definition.id === 'instant_heal') {
      rows = [{ label: 'HEALTH RESTORE', current: 0, next: definition.primaryBase, max: definition.primaryBase, unit: ' HP' }];
    } else if (definition.id === 'max_health_cell') {
      rows = [{ label: 'MAX HEALTH', current: 0, next: definition.primaryBase, max: definition.primaryBase, unit: ' HP' }];
    } else if (definition.slot === 'primary' || definition.slot === 'secondary') {
      const currentRange = currentLevel > 0 ? this.getWeaponRange(definition.id, currentLevel) : 0;
      const nextRange = this.getWeaponRange(definition.id, nextLevel);
      const maxRange = this.getWeaponRange(definition.id, maxLevel);
      rows = [
        { label: 'DAMAGE', current: currentPrimary, next: primary, max: maxPrimary, unit: '', decimals: 1 },
        {
          label: 'FIRE DELAY', current: currentSecondary, next: Math.max(0.04, secondary),
          max: Math.max(definition.secondaryBase, 0.04), unit: 's', decimals: 3, lowerIsBetter: true,
        },
        { label: 'AUTO-AIM RANGE', current: currentRange, next: nextRange, max: maxRange, unit: 'm' },
      ];
    } else if (definition.id === 'damage_guard') {
      rows = [this.percentRow('DAMAGE CUT', currentPrimary, primary, maxPrimary)];
    } else if (definition.id === 'speed_boost') {
      rows = [this.percentRow('MOVE SPEED', currentPrimary, primary, maxPrimary)];
    } else if (definition.id === 'gravity_cut') {
      rows = [this.percentRow('GRAVITY CUT', currentPrimary, primary, maxPrimary)];
    } else if (definition.id === 'blood_siphon') {
      rows = [this.percentRow('DAMAGE SIPHON', currentPrimary, primary, maxPrimary)];
    } else if (definition.id === 'jetpack') {
      rows = [this.percentRow('BOOST THRUST', currentPrimary, primary, maxPrimary)];
    } else if (definition.id === 'wingsuit') {
      rows = [this.percentRow('GLIDE GRAVITY CUT', currentPrimary, primary, maxPrimary)];
    } else if (definition.id === 'armor') {
      rows = [
        { label: 'MAX HEALTH', current: currentPrimary, next: primary, max: maxPrimary, unit: ' HP' },
        this.percentRow('DAMAGE CUT', currentSecondary, secondary, maxSecondary),
      ];
    }

    if (offer.replacedItem) rows.push(...this.getReplacementLossRows(offer.replacedItem));
    return rows;
  }

  private createOffer(definition: ItemDefinition): ItemOffer {
    const currentLevel = this.levels.get(definition.id) ?? 0;
    const nextLevel = definition.maxLevel === 0
      ? 0
      : Math.min(definition.maxLevel, currentLevel + 1);
    let replacedItem: ItemDefinition | undefined;
    if (definition.slot === 'primary' && this.primaryId !== definition.id) {
      replacedItem = this.getDefinition(this.primaryId) ?? undefined;
    } else if (definition.slot === 'secondary' && this.secondaryId && this.secondaryId !== definition.id) {
      replacedItem = this.getDefinition(this.secondaryId) ?? undefined;
    } else if (definition.slot === 'equipment' && this.equipmentId && this.equipmentId !== definition.id) {
      replacedItem = this.getDefinition(this.equipmentId) ?? undefined;
    }
    const status = definition.maxLevel === 0
      ? 'CONSUME'
      : currentLevel > 0
        ? 'UPGRADE'
        : replacedItem
          ? 'REPLACE'
          : 'NEW';
    return { definition, currentLevel, nextLevel, status, replacedItem };
  }

  private getWeaponStats(id: string): WeaponStats {
    const definition = this.getDefinition(id);
    if (!definition) throw new Error(`Unknown weapon item: ${id}`);
    const level = Math.max(1, this.levels.get(id) ?? 1);
    return {
      id,
      level,
      damage: definition.primaryBase + definition.primaryGrowth * (level - 1),
      cooldown: Math.max(0.04, definition.secondaryBase + definition.secondaryGrowth * (level - 1)),
      range: this.getWeaponRange(id, level),
    };
  }

  private getWeaponRange(id: string, level: number): number {
    if (id === 'laser') return 88 + (level - 1) * 2;
    if (id === 'machinegun') return 158 + (level - 1) * 4;
    if (id === 'shotgun') return 68 + (level - 1) * 1.5;
    if (id === 'katana') return 8.5 + level * 0.8;
    if (id === 'missile') return 120 + level * 8;
    if (id === 'air_bomb') return 95 + level * 3;
    return 100;
  }

  private definitionValue(
    definition: ItemDefinition,
    level: number,
    value: 'primary' | 'secondary',
  ): number {
    if (level <= 0) return 0;
    return value === 'primary'
      ? definition.primaryBase + definition.primaryGrowth * (level - 1)
      : definition.secondaryBase + definition.secondaryGrowth * (level - 1);
  }

  private percentRow(label: string, current: number, next: number, max: number): ItemStatComparison {
    return { label, current: current * 100, next: next * 100, max: max * 100, unit: '%', decimals: 0 };
  }

  private getReplacementLossRows(definition: ItemDefinition): ItemStatComparison[] {
    const level = Math.max(1, this.levels.get(definition.id) ?? 1);
    const primary = this.definitionValue(definition, level, 'primary');
    const secondary = this.definitionValue(definition, level, 'secondary');
    if (definition.id === 'armor') {
      return [
        { label: 'LOST MAX HEALTH', current: primary, next: 0, max: primary, unit: ' HP', loss: true },
        { label: 'LOST DAMAGE CUT', current: secondary * 100, next: 0, max: secondary * 100, unit: '%', loss: true },
      ];
    }
    if (definition.id === 'wingsuit') {
      return [{ label: 'LOST GLIDE CUT', current: primary * 100, next: 0, max: primary * 100, unit: '%', loss: true }];
    }
    if (definition.id === 'jetpack') {
      return [{ label: 'LOST BOOST THRUST', current: primary * 100, next: 0, max: primary * 100, unit: '%', loss: true }];
    }
    return [];
  }

  private valueAtLevel(id: string, value: 'primary' | 'secondary'): number {
    const level = this.levels.get(id) ?? 0;
    const definition = this.getDefinition(id);
    if (!definition || level <= 0) return 0;
    return value === 'primary'
      ? definition.primaryBase + definition.primaryGrowth * (level - 1)
      : definition.secondaryBase + definition.secondaryGrowth * (level - 1);
  }
}
