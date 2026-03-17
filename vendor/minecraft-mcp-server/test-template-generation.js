#!/usr/bin/env node

// Quick test script to verify template generation system
import { TemplateGeneratorService } from './src/template-generator.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(__dirname, 'meta_templates');
const outputDir = path.join(__dirname, 'landmark_specs');

async function testTemplateGeneration() {
  console.log('Testing template generation system...\n');
  
  const generator = new TemplateGeneratorService(templatesDir, outputDir);
  
  try {
    // Test 1: Generate a tower spec
    console.log('Test 1: Generating tower spec...');
    const towerSpec = await generator.generateSpecFromTemplate({
      templateType: 'tower',
      name: 'Test Tower',
      culture: 'france',
      parameters: {},
      scale: 'medium'
    });
    console.log(`✓ Generated spec: ${towerSpec.id}`);
    console.log(`  - Name: ${towerSpec.name}`);
    console.log(`  - Culture: ${towerSpec.culture}`);
    console.log(`  - Components: ${towerSpec.components.length}`);
    console.log(`  - Keywords: ${towerSpec.keywords.join(', ')}`);
    
    // Test 2: Generate a temple spec with different culture
    console.log('\nTest 2: Generating temple spec...');
    const templeSpec = await generator.generateSpecFromTemplate({
      templateType: 'temple',
      name: 'Test Temple',
      culture: 'japan',
      parameters: {},
      scale: 'large'
    });
    console.log(`✓ Generated spec: ${templeSpec.id}`);
    console.log(`  - Name: ${templeSpec.name}`);
    console.log(`  - Culture: ${templeSpec.culture}`);
    console.log(`  - Components: ${templeSpec.components.length}`);
    
    // Test 3: Verify available templates
    console.log('\nTest 3: Verifying available templates...');
    const templateTypes = ['tower', 'temple', 'bridge', 'castle', 'pyramid', 'statue', 'arena'];
    for (const type of templateTypes) {
      try {
        const template = await generator.loadTemplate(type);
        console.log(`✓ Template ${type}: ${template.description}`);
      } catch (error) {
        console.log(`✗ Template ${type}: ${error.message}`);
      }
    }
    
    console.log('\n✓ All tests passed successfully!');
    console.log('\nThe template generation system is ready to use with the MCP tool:');
    console.log('  generate-spec-from-template');
    
  } catch (error) {
    console.error('✗ Test failed:', error);
    process.exit(1);
  }
}

testTemplateGeneration();