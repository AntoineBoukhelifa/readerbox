import { describe, expect, it } from 'vitest';
import { cleDeRecherche, creerCacheDeRecherche } from './cache';

describe('cache court des réponses de recherche', () => {
	function horloge(depart = 0) {
		let instant = depart;
		return { maintenant: () => instant, avancer: (ms: number) => (instant += ms) };
	}

	it('rend ce qui a été écrit dans la fenêtre', () => {
		const temps = horloge();
		const cache = creerCacheDeRecherche({ dureeMs: 1000, maintenant: temps.maintenant });

		cache.ecrire('a', [1, 2]);
		temps.avancer(999);

		expect(cache.lire('a')).toEqual([1, 2]);
	});

	it('oublie passé la fenêtre : une correction chez la source doit pouvoir réapparaître', () => {
		const temps = horloge();
		const cache = creerCacheDeRecherche({ dureeMs: 1000, maintenant: temps.maintenant });

		cache.ecrire('a', [1]);
		temps.avancer(1000);

		expect(cache.lire('a')).toBeUndefined();
	});

	it('la relecture ne prolonge pas la durée de vie', () => {
		const temps = horloge();
		const cache = creerCacheDeRecherche({ dureeMs: 1000, maintenant: temps.maintenant });

		cache.ecrire('a', [1]);
		temps.avancer(900);
		expect(cache.lire('a')).toEqual([1]);
		temps.avancer(200);

		expect(cache.lire('a')).toBeUndefined();
	});

	it('borne sa taille en évinçant la plus ancienne — un Worker n’a pas de mémoire à gaspiller', () => {
		const cache = creerCacheDeRecherche({ entreesMax: 2 });

		cache.ecrire('a', 1);
		cache.ecrire('b', 2);
		cache.ecrire('c', 3);

		expect(cache.lire('a')).toBeUndefined();
		expect(cache.lire('b')).toBe(2);
		expect(cache.lire('c')).toBe(3);
	});

	it('une clé relue remonte et échappe à l’éviction', () => {
		const cache = creerCacheDeRecherche({ entreesMax: 2 });

		cache.ecrire('a', 1);
		cache.ecrire('b', 2);
		cache.lire('a');
		cache.ecrire('c', 3);

		expect(cache.lire('a')).toBe(1);
		expect(cache.lire('b')).toBeUndefined();
	});
});

describe('clé de recherche', () => {
	it('normalise la casse et les espaces : deux membres qui tapent pareil ne paient qu’une fois', () => {
		expect(cleDeRecherche('metron', '  Immortal   X-Men ')).toBe(
			cleDeRecherche('metron', 'immortal x-men')
		);
	});

	it('sépare les sources : elles ne répondent pas la même chose', () => {
		expect(cleDeRecherche('metron', 'x')).not.toBe(cleDeRecherche('tmdb', 'x'));
	});

	it('ne porte aucun identifiant de membre — sinon le cache perdrait son facteur vingt', () => {
		expect(cleDeRecherche('metron', 'x')).not.toMatch(/membre|member/i);
	});
});
