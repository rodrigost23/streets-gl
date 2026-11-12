import type {Config} from '@jest/types';

const config: Config.InitialOptions = {
	verbose: true,
	transform: {
		'^.+\\.tsx?$': 'ts-jest',
		// Plain JavaScript modules of the project are written as ES modules
		'^.+/src/lib/math/OMBB\\.js$': ['ts-jest', {tsconfig: {allowJs: true, module: 'commonjs'}}],
	},
	moduleNameMapper: {
		'~/(.*)': '<rootDir>/src/$1'
	},
};

export default config;