import { describe, expect, it } from 'vitest';
import { calculerProgression, pourcentageAffiche, type EntreeDOrdre } from './progression';

/**
 * La règle de progression, sans base.
 *
 * `orders.test.ts` éprouve la même mécanique à travers les vraies écritures ;
 * ici on ne teste que l'arithmétique de KTD8, là où elle se lit d'un coup d'œil.
 */

/** Une séquence de `n` entrées essentielles, rangs 0 à n-1. */
function sequence(n: number, facultatives: number[] = []): EntreeDOrdre[] {
	return Array.from({ length: n }, (_, index) => ({
		id: `e${index + 1}`,
		oeuvreId: `o${index + 1}`,
		rang: index,
		facultative: facultatives.includes(index + 1)
	}));
}

describe('AE5 — le pourcentage et l’entrée suivante (R19, R20)', () => {
	it('dix entrées essentielles dont les 1, 2, 5 et 9 sont atteintes : 40 % et l’entrée suivante est la troisième', () => {
		const entrees = sequence(10);
		const atteintes = new Set(['o1', 'o2', 'o5', 'o9']);

		const progression = calculerProgression(entrees, atteintes);

		expect(progression.pourcentage).toBe(40);
		expect(progression.essentiellesAtteintes).toBe(4);
		expect(progression.essentielles).toBe(10);
		expect(progression.entreeSuivante?.id).toBe('e3');
		expect(progression.atteintes).toEqual(['e1', 'e2', 'e5', 'e9']);
	});

	it('l’ensemble atteint est rendu dans l’ordre de la séquence, quel que soit l’ordre d’entrée', () => {
		const desordonnees = [...sequence(4)].reverse();

		const progression = calculerProgression(desordonnees, new Set(['o4', 'o1']));

		expect(progression.atteintes).toEqual(['e1', 'e4']);
		expect(progression.entreeSuivante?.id).toBe('e2');
	});

	it('un ordre entièrement atteint n’a pas d’entrée suivante', () => {
		const progression = calculerProgression(sequence(3), new Set(['o1', 'o2', 'o3']));

		expect(progression.pourcentage).toBe(100);
		expect(progression.entreeSuivante).toBe(null);
	});

	it('un membre qui n’a rien atteint est à 0 %, pas à null', () => {
		const progression = calculerProgression(sequence(3), new Set());

		expect(progression.pourcentage).toBe(0);
		expect(progression.entreeSuivante?.id).toBe('e1');
		expect(progression.atteintes).toEqual([]);
	});
});

describe('R18 — les entrées facultatives', () => {
	it('sont exclues du dénominateur', () => {
		// Cinq entrées, dont les 2 et 4 facultatives : trois essentielles.
		const entrees = sequence(5, [2, 4]);

		const progression = calculerProgression(entrees, new Set(['o1', 'o3']));

		expect(progression.essentielles).toBe(3);
		expect(progression.essentiellesAtteintes).toBe(2);
		expect(progression.pourcentage).toBeCloseTo(66.67, 1);
	});

	it('un membre qui les saute toutes atteint quand même 100 %', () => {
		const entrees = sequence(4, [2, 3]);

		const progression = calculerProgression(entrees, new Set(['o1', 'o4']));

		expect(progression.pourcentage).toBe(100);
		expect(progression.entreeSuivante).toBe(null);
	});

	it('ne sont jamais proposées comme entrée suivante', () => {
		// La 2 est facultative et non atteinte : la suivante saute par-dessus.
		const entrees = sequence(3, [2]);

		const progression = calculerProgression(entrees, new Set(['o1']));

		expect(progression.entreeSuivante?.id).toBe('e3');
	});

	it('comptent malgré tout dans l’ensemble atteint de R19', () => {
		const entrees = sequence(3, [2]);

		const progression = calculerProgression(entrees, new Set(['o1', 'o2']));

		expect(progression.atteintes).toEqual(['e1', 'e2']);
		// Mais pas dans le numérateur : une seule essentielle sur deux.
		expect(progression.pourcentage).toBe(50);
	});
});

describe('le dénominateur nul', () => {
	it('un ordre vide n’a pas de pourcentage, ni 0 ni 100', () => {
		const progression = calculerProgression([], new Set());

		expect(progression.pourcentage).toBe(null);
		expect(progression.entreeSuivante).toBe(null);
		expect(progression.total).toBe(0);
		expect(pourcentageAffiche(progression)).toBe(null);
	});

	it('un ordre entièrement facultatif n’a pas non plus de pourcentage', () => {
		const entrees = sequence(3, [1, 2, 3]);

		const progression = calculerProgression(entrees, new Set(['o1']));

		expect(progression.pourcentage).toBe(null);
		expect(progression.entreeSuivante).toBe(null);
		// L'ensemble atteint, lui, existe bel et bien.
		expect(progression.atteintes).toEqual(['e1']);
		expect(progression.total).toBe(3);
	});
});

describe('une œuvre disparue du catalogue', () => {
	it('sort du dénominateur : elle ne peut plus jamais être atteinte', () => {
		const entrees = sequence(3);
		entrees[1].introuvable = true;

		const progression = calculerProgression(entrees, new Set(['o1', 'o3']));

		expect(progression.essentielles).toBe(2);
		expect(progression.pourcentage).toBe(100);
	});

	it('n’est jamais proposée comme entrée suivante', () => {
		const entrees = sequence(3);
		entrees[0].introuvable = true;

		const progression = calculerProgression(entrees, new Set());

		expect(progression.entreeSuivante?.id).toBe('e2');
	});

	it('n’entre pas dans l’ensemble atteint, même si son identifiant y traîne encore', () => {
		const entrees = sequence(2);
		entrees[0].introuvable = true;

		const progression = calculerProgression(entrees, new Set(['o1', 'o2']));

		expect(progression.atteintes).toEqual(['e2']);
	});
});

describe('AE6 — insérer une entrée ne retire rien de l’ensemble atteint', () => {
	it('l’ensemble est identique avant et après insertion ; seul le pourcentage baisse', () => {
		const avant = sequence(4);
		const atteintes = new Set(['o1', 'o2']);
		const progressionAvant = calculerProgression(avant, atteintes);

		// L'auteur insère une entrée en deuxième position. Les entrées existantes
		// gardent leur identité (R15) ; seuls leurs rangs bougent.
		const apres: EntreeDOrdre[] = [
			avant[0],
			{ id: 'inseree', oeuvreId: 'o-neuve', rang: 1, facultative: false },
			...avant.slice(1).map((entree) => ({ ...entree, rang: entree.rang + 1 }))
		];
		const progressionApres = calculerProgression(apres, atteintes);

		expect(progressionApres.atteintes).toEqual(progressionAvant.atteintes);
		expect(progressionAvant.pourcentage).toBe(50);
		expect(progressionApres.pourcentage).toBe(40);
		// Et l'entrée suivante est recalculée : c'est celle qu'on vient d'insérer.
		expect(progressionAvant.entreeSuivante?.id).toBe('e3');
		expect(progressionApres.entreeSuivante?.id).toBe('inseree');
	});
});

describe('réordonner', () => {
	it('ne change aucun ensemble atteint', () => {
		const entrees = sequence(5);
		const atteintes = new Set(['o2', 'o4']);
		const avant = calculerProgression(entrees, atteintes);

		// La cinquième passe en tête ; tout le reste décale.
		const rangs: Record<string, number> = { e5: 0, e1: 1, e2: 2, e3: 3, e4: 4 };
		const apres = calculerProgression(
			entrees.map((entree) => ({ ...entree, rang: rangs[entree.id] })),
			atteintes
		);

		expect([...apres.atteintes].sort()).toEqual([...avant.atteintes].sort());
		expect(apres.pourcentage).toBe(avant.pourcentage);
		// L'entrée suivante, elle, suit la séquence : c'est son rôle.
		expect(avant.entreeSuivante?.id).toBe('e1');
		expect(apres.entreeSuivante?.id).toBe('e5');
	});
});

describe('l’affichage', () => {
	it('arrondit à l’entier le plus proche', () => {
		const progression = calculerProgression(sequence(3), new Set(['o1']));

		expect(progression.pourcentage).toBeCloseTo(33.33, 1);
		expect(pourcentageAffiche(progression)).toBe(33);
	});
});
