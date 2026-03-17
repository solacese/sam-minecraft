import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { LandmarkSpec } from './landmark-autonomy.js';

interface MetaTemplate {
  templateType: string;
  description: string;
  parameters: Record<string, TemplateParameter>;
  generationRules: {
    scaleMapping?: Record<string, { height: number; width: number; [key: string]: any }>;
    componentStructure: TemplateComponent[];
    [key: string]: any;
  };
}

interface TemplateParameter {
  type: string;
  required: boolean;
  values?: string[];
  description?: string;
}

interface TemplateComponent {
  id: string;
  role: string;
  heightPercent: number;
  scaleMultiplier: number;
  conditional?: string;
}

interface GenerateSpecParams {
  templateType: string;
  name: string;
  culture: string;
  parameters: Record<string, any>;
  scale?: string;
  stylePreset?: string;
}

const CULTURE_STYLES: Record<string, { primary: string; secondary: string; accent: string; detail: string; roof: string; path: string; glass: string }> = {
  france: {
    primary: 'minecraft:stone_bricks',
    secondary: 'minecraft:smooth_stone',
    accent: 'minecraft:iron_block',
    detail: 'minecraft:quartz_block',
    roof: 'minecraft:gray_terracotta',
    path: 'minecraft:cobblestone',
    glass: 'minecraft:glass'
  },
  egypt: {
    primary: 'minecraft:sandstone',
    secondary: 'minecraft:smooth_sandstone',
    accent: 'minecraft:gold_block',
    detail: 'minecraft:chiseled_sandstone',
    roof: 'minecraft:yellow_terracotta',
    path: 'minecraft:sand',
    glass: 'minecraft:orange_stained_glass'
  },
  japan: {
    primary: 'minecraft:dark_oak_planks',
    secondary: 'minecraft:spruce_planks',
    accent: 'minecraft:red_terracotta',
    detail: 'minecraft:paper',
    roof: 'minecraft:dark_oak_stairs',
    path: 'minecraft:gravel',
    glass: 'minecraft:white_stained_glass_pane'
  },
  default: {
    primary: 'minecraft:stone',
    secondary: 'minecraft:cobblestone',
    accent: 'minecraft:iron_block',
    detail: 'minecraft:white_wool',
    roof: 'minecraft:oak_planks',
    path: 'minecraft:dirt',
    glass: 'minecraft:glass'
  }
};

export class TemplateGeneratorService {
  constructor(
    private readonly templateDir: string,
    private readonly outputDir: string
  ) {}

  async loadTemplate(templateType: string): Promise<MetaTemplate> {
    const fileName = `${templateType}_template.json`;
    const filePath = path.join(this.templateDir, fileName);
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as MetaTemplate;
  }

  async generateSpecFromTemplate(params: GenerateSpecParams): Promise<LandmarkSpec> {
    const template = await this.loadTemplate(params.templateType);
    
    // Validate required parameters
    for (const [key, param] of Object.entries(template.parameters)) {
      if (param.required && !(key in params.parameters)) {
        throw new Error(`Missing required parameter: ${key}`);
      }
    }

    const scale = params.scale || 'medium';
    const scaleConfig = template.generationRules.scaleMapping?.[scale] || 
                       template.generationRules.scaleMapping?.['medium'] || 
                       { height: 30, width: 20 };

    const culture = params.culture.toLowerCase();
    const stylePalette = CULTURE_STYLES[culture] || CULTURE_STYLES.default;

    // Generate components from template
    const components = template.generationRules.componentStructure
      .filter(comp => !comp.conditional || params.parameters[comp.conditional])
      .map((comp, index) => {
        const height = Math.round((scaleConfig.height * comp.heightPercent) / 100);
        const width = Math.round(scaleConfig.width * comp.scaleMultiplier);
        const depth = width;

        return {
          id: comp.id,
          label: comp.id.replace(/_/g, ' '),
          role: comp.role,
          primaryTool: this.selectToolForRole(comp.role),
          dependencies: index > 0 ? [template.generationRules.componentStructure[index - 1].id] : [],
          offsetX: 0,
          offsetZ: 0,
          offsetY: Math.round((scaleConfig.height * template.generationRules.componentStructure.slice(0, index).reduce((sum, c) => sum + c.heightPercent, 0)) / 100),
          width,
          depth,
          height,
          materialKey: this.selectMaterialForRole(comp.role),
          blockBudget: width * depth * height
        };
      });

    const spec: LandmarkSpec = {
      schemaVersion: '1.0',
      id: `${params.name.toLowerCase().replace(/\s+/g, '_')}_${culture}_generated`,
      name: params.name,
      culture: params.culture,
      description: `Generated ${params.templateType} structure: ${params.name}`,
      keywords: this.generateKeywords(params.templateType, params.name),
      defaultStyle: params.stylePreset || 'default',
      styles: {
        [params.stylePreset || 'default']: stylePalette
      },
      scaleVariants: {
        small: { footprintScale: 0.7, heightScale: 0.7, budgetScale: 0.6 },
        medium: { footprintScale: 1.0, heightScale: 1.0, budgetScale: 1.0 },
        large: { footprintScale: 1.4, heightScale: 1.4, budgetScale: 1.6 }
      },
      components,
      qualityRules: []
    };

    return spec;
  }

  async saveSpec(spec: LandmarkSpec): Promise<string> {
    await fs.mkdir(this.outputDir, { recursive: true });
    const fileName = `${spec.id}.json`;
    const filePath = path.join(this.outputDir, fileName);
    await fs.writeFile(filePath, JSON.stringify(spec, null, 2), 'utf8');
    return filePath;
  }

  private selectToolForRole(role: string): 'fill-region' | 'flatten-area' | 'place-block' | 'plant-garden' | 'build-decorated-house' {
    if (role === 'site') return 'flatten-area';
    if (role === 'ornament') return 'place-block';
    return 'fill-region';
  }

  private selectMaterialForRole(role: string): 'primary' | 'secondary' | 'accent' | 'detail' | 'roof' | 'path' | 'glass' {
    if (role === 'site') return 'path';
    if (role === 'foundation') return 'secondary';
    if (role === 'roof') return 'roof';
    if (role === 'ornament') return 'accent';
    return 'primary';
  }

  private generateKeywords(templateType: string, name: string): string[] {
    const keywords = [templateType, name.toLowerCase()];
    
    // Add template-specific keywords
    if (templateType === 'tower') keywords.push('tall', 'vertical', 'spire');
    if (templateType === 'temple') keywords.push('religious', 'worship', 'sacred');
    if (templateType === 'bridge') keywords.push('crossing', 'span', 'arch');
    if (templateType === 'castle') keywords.push('fortress', 'fortification', 'defense');
    if (templateType === 'pyramid') keywords.push('monumental', 'ancient', 'tomb');
    if (templateType === 'statue') keywords.push('monument', 'sculpture', 'figure');
    if (templateType === 'arena') keywords.push('stadium', 'amphitheater', 'colosseum');
    
    return keywords;
  }
}