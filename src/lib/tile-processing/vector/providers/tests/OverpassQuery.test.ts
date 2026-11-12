import {getRequestBody} from "~/lib/tile-processing/vector/providers/OverpassVectorFeatureProvider";

describe('Overpass request body', () => {
	const body = getRequestBody(24891, 37056, 16);
	const statements = body
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith('//'));

	it('should use the same bounding box in every spatial statement', () => {
		const boxes = new Set(Array.from(body.matchAll(/\((-?\d+\.\d+,-?\d+\.\d+,-?\d+\.\d+,-?\d+\.\d+)\)/g)).map(m => m[1]));

		expect(boxes.size).toBe(1);
	});

	it('should never request unfiltered nodes, ways or relations', () => {
		expect(body).not.toMatch(/\bnode\(/);
		expect(body).not.toMatch(/\bway\(/);
		expect(body).not.toMatch(/\brel\(/);
	});

	it('should request only features that are rendered', () => {
		expect(body).toContain('way["building"]');
		expect(body).toContain('way["highway"]');
		expect(body).toContain('rel["type"="building"]');
		expect(body).toContain('node["natural"~"^(tree|rock)$"]');
		// Large areas come from OpenFreeMap
		expect(body).not.toMatch(/natural"~"[^"]*\b(wood|water|scrub)\b/);
		expect(body).not.toContain('["landuse"]');
		expect(body).not.toContain('forest');
	});

	it('should print every element only once', () => {
		expect(statements.filter(s => s.startsWith('out '))).toEqual(['out body qt;']);
		expect(body).toContain('(.features; >>;);');
	});

	it('should have balanced brackets and terminated statements', () => {
		const code = statements.join('\n');

		expect((code.match(/\(/g) ?? []).length).toBe((code.match(/\)/g) ?? []).length);
		expect((code.match(/\[/g) ?? []).length).toBe((code.match(/\]/g) ?? []).length);

		for (const statement of statements) {
			expect(statement.endsWith(';') || statement === '(' || statement === ') ->.features;').toBe(true);
		}
	});
});
