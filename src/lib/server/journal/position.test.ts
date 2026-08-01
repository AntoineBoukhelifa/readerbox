import { describe, expect, it } from 'vitest';
import type { EtatDeLecture } from './atteinte';
import { POSITION_MAX, normaliserPosition, positionEffective } from './position';

const etat = (etagere: EtatDeLecture['etagere'], abandonnee = false): EtatDeLecture => ({
	etagere,
	abandonnee
});

describe('normalisation de la position saisie (R23)', () => {
	it('un pourcentage devient une fraction', () => {
		expect(normaliserPosition({ unite: 'pourcentage', valeur: 30 })).toEqual({
			ok: true,
			position: 0.3,
			longueurTotale: null
		});
	});

	it('une page devient la même fraction, et c est tout l intérêt', () => {
		const enPages = normaliserPosition({ unite: 'page', valeur: 90, longueurTotale: 300 });
		const enPourcentage = normaliserPosition({ unite: 'pourcentage', valeur: 30 });

		expect(enPages.ok && enPages.position).toBe(enPourcentage.ok && enPourcentage.position);
	});

	it('une page retient la longueur déclarée, pour les saisies suivantes', () => {
		expect(normaliserPosition({ unite: 'page', valeur: 150, longueurTotale: 300 })).toEqual({
			ok: true,
			position: 0.5,
			longueurTotale: 300
		});
	});

	it('une page se convertit avec la longueur déjà connue de l entrée', () => {
		expect(normaliserPosition({ unite: 'page', valeur: 150 }, { longueurTotale: 300 })).toEqual({
			ok: true,
			position: 0.5,
			longueurTotale: 300
		});
	});

	it('une saisie en pages sans longueur connue est refusée, pas devinée', () => {
		expect(normaliserPosition({ unite: 'page', valeur: 150 })).toEqual({
			ok: false,
			motif: 'longueur inconnue'
		});
	});

	it('les bornes tiennent aux deux extrémités', () => {
		expect(normaliserPosition({ unite: 'pourcentage', valeur: 0 })).toEqual({
			ok: true,
			position: 0,
			longueurTotale: null
		});
		expect(normaliserPosition({ unite: 'pourcentage', valeur: 100 })).toEqual({
			ok: true,
			position: 1,
			longueurTotale: null
		});
	});

	it('une position hors bornes est refusée', () => {
		expect(normaliserPosition({ unite: 'pourcentage', valeur: 101 })).toEqual({
			ok: false,
			motif: 'hors bornes'
		});
		expect(normaliserPosition({ unite: 'pourcentage', valeur: -1 })).toEqual({
			ok: false,
			motif: 'hors bornes'
		});
		expect(normaliserPosition({ unite: 'page', valeur: 301, longueurTotale: 300 })).toEqual({
			ok: false,
			motif: 'hors bornes'
		});
	});

	it('une longueur nulle ou négative n est pas une longueur', () => {
		expect(normaliserPosition({ unite: 'page', valeur: 1, longueurTotale: 0 })).toEqual({
			ok: false,
			motif: 'longueur inconnue'
		});
	});

	it('une valeur qui n est pas un nombre est refusée', () => {
		expect(normaliserPosition({ unite: 'pourcentage', valeur: Number.NaN })).toEqual({
			ok: false,
			motif: 'valeur invalide'
		});
	});
});

describe('position effective (R24)', () => {
	it('est nulle tant que l œuvre n est pas commencée', () => {
		expect(positionEffective(etat('a_decouvrir'), 0.4)).toBe(0);
	});

	it('est nulle quand l œuvre n est pas consignée du tout', () => {
		expect(positionEffective(null, 0.4)).toBe(0);
	});

	it('est totale dès que l œuvre est atteinte', () => {
		expect(positionEffective(etat('termine'), null)).toBe(POSITION_MAX);
		expect(positionEffective(etat('en_cours', true), 0.3)).toBe(POSITION_MAX);
	});

	it('est la dernière valeur déclarée quand l œuvre est en cours', () => {
		expect(positionEffective(etat('en_cours'), 0.42)).toBe(0.42);
	});

	it('est nulle quand l œuvre est en cours sans position déclarée', () => {
		expect(positionEffective(etat('en_cours'), null)).toBe(0);
	});

	it('redevient la dernière valeur déclarée quand une œuvre abandonnée est reprise', () => {
		expect(positionEffective(etat('en_cours', true), 0.3)).toBe(POSITION_MAX);
		expect(positionEffective(etat('en_cours'), 0.3)).toBe(0.3);
	});
});
