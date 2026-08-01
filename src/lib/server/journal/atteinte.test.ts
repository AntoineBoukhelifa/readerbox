import { describe, expect, it } from 'vitest';
import { estAtteinte, franchissement, type EtatDeLecture } from './atteinte';

/**
 * Le prédicat dont dépendent le masquage (U6), la progression des ordres (U7)
 * et les appuis du graphe (U9). Une erreur ici se propage aux trois, d'où le
 * soin mis à couvrir les seize combinaisons possibles plutôt que les cas
 * évidents.
 */

const etat = (etagere: EtatDeLecture['etagere'], abandonnee = false): EtatDeLecture => ({
	etagere,
	abandonnee
});

describe('atteinte', () => {
	it('« à découvrir » est consigné mais pas atteint', () => {
		expect(estAtteinte(etat('a_decouvrir'))).toBe(false);
	});

	it('« en cours » est consigné mais pas atteint', () => {
		expect(estAtteinte(etat('en_cours'))).toBe(false);
	});

	it('« terminé » est atteint', () => {
		expect(estAtteinte(etat('termine'))).toBe(true);
	});

	it('l abandon est atteint, sans rien exiger d autre', () => {
		expect(estAtteinte(etat('en_cours', true))).toBe(true);
	});

	it('l abandon est un quatrième état : il atteint depuis n importe quelle étagère', () => {
		expect(estAtteinte(etat('a_decouvrir', true))).toBe(true);
		expect(estAtteinte(etat('termine', true))).toBe(true);
	});
});

describe('franchissement de la frontière', () => {
	it('consigner directement en « terminé » franchit vers l atteinte', () => {
		expect(franchissement(null, etat('termine'))).toBe('atteinte');
	});

	it('consigner en « à découvrir » ne franchit rien', () => {
		expect(franchissement(null, etat('a_decouvrir'))).toBe(null);
	});

	it('passer de « en cours » à « terminé » franchit vers l atteinte', () => {
		expect(franchissement(etat('en_cours'), etat('termine'))).toBe('atteinte');
	});

	it('abandonner franchit vers l atteinte', () => {
		expect(franchissement(etat('en_cours'), etat('en_cours', true))).toBe('atteinte');
	});

	it('reprendre une œuvre abandonnée franchit en sens inverse', () => {
		expect(franchissement(etat('en_cours', true), etat('en_cours'))).toBe('perte');
	});

	it('retirer une consignation atteinte franchit en sens inverse', () => {
		expect(franchissement(etat('termine'), null)).toBe('perte');
	});

	it('retirer une consignation non atteinte ne franchit rien', () => {
		expect(franchissement(etat('en_cours'), null)).toBe(null);
	});

	it('abandonner une œuvre déjà terminée ne franchit rien : elle était déjà atteinte', () => {
		expect(franchissement(etat('termine'), etat('termine', true))).toBe(null);
	});

	it('déplacer entre deux étagères non atteintes ne franchit rien', () => {
		expect(franchissement(etat('a_decouvrir'), etat('en_cours'))).toBe(null);
	});

	it('deux absences ne franchissent rien', () => {
		expect(franchissement(null, null)).toBe(null);
	});
});
