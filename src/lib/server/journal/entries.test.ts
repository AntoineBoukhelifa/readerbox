import { describe, expect, it } from 'vitest';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import { ingererOeuvre } from '../catalog/ingest';
import { corriger } from '../catalog/corrections';
import { T0, entite, membre, oeuvreDistante } from '../catalog/testing';
import { works } from '../db/schema';
import { eq } from 'drizzle-orm';
import {
	abandonner,
	agregatDOeuvre,
	agregatDeSerie,
	consigner,
	declarerPosition,
	ecrireAvis,
	lireConsignation,
	lireJournal,
	modifierAvis,
	noteValide,
	noter,
	reprendre,
	retirer,
	supprimerAvis
} from './entries';
import { franchissementEnAttente } from './frontiere';
import type { TypeOeuvre } from '../catalog/sources/types';

/** Une œuvre du catalogue, ingérée comme un adaptateur le ferait. */
async function oeuvre(
	db: Db,
	idExterne: string,
	champs: { titre?: string; type?: TypeOeuvre; serie?: string; numero?: number } = {}
): Promise<string> {
	const { oeuvreId } = await ingererOeuvre(
		db,
		oeuvreDistante('metron', idExterne, {
			titre: champs.titre ?? `Numéro ${idExterne}`,
			...(champs.type ? { type: champs.type } : {}),
			...(champs.serie ? { serie: entite('metron', champs.serie, 'Uncanny X-Men') } : {}),
			...(champs.numero !== undefined ? { numeroDansLaSerie: champs.numero } : {})
		}),
		{ now: T0 }
	);
	return oeuvreId;
}

describe('consigner (R1)', () => {
	it('consigner en « à découvrir » ne rend pas l œuvre atteinte', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');

		const resultat = await consigner(db, { membreId, oeuvreId, etagere: 'a_decouvrir', now: T0 });

		expect(resultat).toEqual({
			ok: true,
			entreeId: expect.any(String),
			atteinte: false,
			franchissement: null
		});
	});

	it('« en cours » ne rend pas l œuvre atteinte', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'a_decouvrir', now: T0 });

		const resultat = await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 + 1 });

		expect(resultat.ok && resultat.atteinte).toBe(false);
		expect(resultat.ok && resultat.franchissement).toBe(null);
	});

	it('« terminé » rend l œuvre atteinte, et le notifie', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 });

		const resultat = await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 + 1 });

		expect(resultat.ok && resultat.atteinte).toBe(true);
		expect(resultat.ok && resultat.franchissement).toBe('atteinte');
		expect(await franchissementEnAttente(db, membreId, oeuvreId)).toMatchObject({
			direction: 'atteinte'
		});
	});

	it('consigner deux fois la même œuvre déplace l étagère sans créer de doublon', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');

		const premiere = await consigner(db, { membreId, oeuvreId, etagere: 'a_decouvrir', now: T0 });
		const seconde = await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 + 1 });

		expect(seconde.ok && seconde.entreeId).toBe(premiere.ok && premiere.entreeId);
		expect(await lireJournal(db, membreId)).toHaveLength(1);
		expect((await lireConsignation(db, membreId, oeuvreId))?.etagere).toBe('en_cours');
	});

	it('conserve la provenance de la première consignation (R42)', async () => {
		const db = createTestDb();
		const membreId = await membre(db, 'Antoine');
		const prescripteur = await membre(db, 'Camille');
		const oeuvreId = await oeuvre(db, '1');

		await consigner(db, {
			membreId,
			oeuvreId,
			provenance: { type: 'membre', membreId: prescripteur },
			now: T0
		});
		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 + 1 });

		expect((await lireConsignation(db, membreId, oeuvreId))?.provenance).toEqual({
			type: 'membre',
			membreId: prescripteur
		});
	});

	it('retient une provenance de catalogue quand rien n est déclaré', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');

		await consigner(db, { membreId, oeuvreId, now: T0 });

		expect((await lireConsignation(db, membreId, oeuvreId))?.provenance).toEqual({
			type: 'catalogue'
		});
	});

	it('refuse une œuvre que le catalogue ne connaît pas', async () => {
		const db = createTestDb();
		const membreId = await membre(db);

		expect(await consigner(db, { membreId, oeuvreId: 'inexistante', now: T0 })).toEqual({
			ok: false,
			motif: 'œuvre introuvable'
		});
	});
});

describe('abandon et reprise (R2, R3, R35)', () => {
	it('l abandon rend atteint sans exiger de note ni d avis', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 });

		const resultat = await abandonner(db, { membreId, oeuvreId, now: T0 + 1 });

		expect(resultat.ok && resultat.atteinte).toBe(true);
		expect(resultat.ok && resultat.franchissement).toBe('atteinte');

		const entree = await lireConsignation(db, membreId, oeuvreId);
		expect(entree?.note).toBe(null);
		expect(entree?.avis).toBe(null);
		expect(entree?.etagere).toBe('en_cours');
	});

	it('reprendre une œuvre abandonnée la fait cesser d être atteinte, et le notifie', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 });
		await abandonner(db, { membreId, oeuvreId, now: T0 + 1 });

		const resultat = await reprendre(db, { membreId, oeuvreId, now: T0 + 2 });

		expect(resultat.ok && resultat.atteinte).toBe(false);
		expect(resultat.ok && resultat.franchissement).toBe('perte');
		expect(await franchissementEnAttente(db, membreId, oeuvreId)).toMatchObject({
			direction: 'perte'
		});
	});

	it('reconsigner en « en cours » lève aussi l abandon', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 });
		await abandonner(db, { membreId, oeuvreId, now: T0 + 1 });

		const resultat = await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 + 2 });

		expect(resultat.ok && resultat.atteinte).toBe(false);
		expect(resultat.ok && resultat.franchissement).toBe('perte');
	});

	it('abandonner une œuvre déjà terminée ne franchit rien', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });

		const resultat = await abandonner(db, { membreId, oeuvreId, now: T0 + 1 });

		expect(resultat.ok && resultat.franchissement).toBe(null);
		expect(resultat.ok && resultat.atteinte).toBe(true);
	});

	it('abandonner une œuvre non consignée est refusé', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');

		expect(await abandonner(db, { membreId, oeuvreId, now: T0 })).toEqual({
			ok: false,
			motif: 'consignation introuvable'
		});
	});
});

describe('note et avis (R4, R5)', () => {
	it('une note peut exister sans avis', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });

		expect(await noter(db, { membreId, oeuvreId, note: 4.5, now: T0 + 1 })).toMatchObject({
			ok: true
		});

		const entree = await lireConsignation(db, membreId, oeuvreId);
		expect(entree?.note).toBe(4.5);
		expect(entree?.avis).toBe(null);
	});

	it('un avis peut exister sans note', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });

		expect(await ecrireAvis(db, { membreId, oeuvreId, texte: 'Sidérant.', now: T0 + 1 })).toEqual({
			ok: true,
			avisId: expect.any(String)
		});

		const entree = await lireConsignation(db, membreId, oeuvreId);
		expect(entree?.note).toBe(null);
		expect(entree?.avis?.texte).toBe('Sidérant.');
	});

	it('accepte les demi-étoiles et refuse le reste', () => {
		expect(noteValide(0.5)).toBe(true);
		expect(noteValide(3)).toBe(true);
		expect(noteValide(5)).toBe(true);
		expect(noteValide(3.7)).toBe(false);
		expect(noteValide(0)).toBe(false);
		expect(noteValide(5.5)).toBe(false);
		expect(noteValide(Number.NaN)).toBe(false);
	});

	it('refuse une note qui n est pas une demi-étoile', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });

		expect(await noter(db, { membreId, oeuvreId, note: 3.7, now: T0 + 1 })).toEqual({
			ok: false,
			motif: 'note invalide'
		});
		expect((await lireConsignation(db, membreId, oeuvreId))?.note).toBe(null);
	});

	it('retirer sa note laisse la consignation et l avis en place (R37)', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });
		await noter(db, { membreId, oeuvreId, note: 4, now: T0 + 1 });
		await ecrireAvis(db, { membreId, oeuvreId, texte: 'Bien.', now: T0 + 2 });

		await noter(db, { membreId, oeuvreId, note: null, now: T0 + 3 });

		const entree = await lireConsignation(db, membreId, oeuvreId);
		expect(entree?.note).toBe(null);
		expect(entree?.avis?.texte).toBe('Bien.');
	});

	it('refuse un avis vide et un second avis sur la même œuvre', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });

		expect(await ecrireAvis(db, { membreId, oeuvreId, texte: '   ', now: T0 + 1 })).toEqual({
			ok: false,
			motif: 'avis vide'
		});

		await ecrireAvis(db, { membreId, oeuvreId, texte: 'Un.', now: T0 + 2 });
		expect(await ecrireAvis(db, { membreId, oeuvreId, texte: 'Deux.', now: T0 + 3 })).toEqual({
			ok: false,
			motif: 'avis déjà écrit'
		});
	});

	it('refuse une note ou un avis sur une œuvre non consignée', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');

		expect(await noter(db, { membreId, oeuvreId, note: 4, now: T0 })).toEqual({
			ok: false,
			motif: 'consignation introuvable'
		});
		expect(await ecrireAvis(db, { membreId, oeuvreId, texte: 'Tiens.', now: T0 })).toEqual({
			ok: false,
			motif: 'consignation introuvable'
		});
	});
});

describe('retrait (R33)', () => {
	it('retirer une consignation supprime la note et l avis associés', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });
		await noter(db, { membreId, oeuvreId, note: 4, now: T0 + 1 });
		await ecrireAvis(db, { membreId, oeuvreId, texte: 'Bien.', now: T0 + 2 });

		const resultat = await retirer(db, { membreId, oeuvreId, now: T0 + 3 });

		expect(resultat).toEqual({
			ok: true,
			franchissement: 'perte',
			noteSupprimee: true,
			avisSupprime: true,
			entreeConservee: false
		});
		expect(await lireConsignation(db, membreId, oeuvreId)).toBe(null);
		expect(await agregatDOeuvre(db, oeuvreId)).toEqual({
			noteMoyenne: null,
			nombreDeNotes: 0,
			nombreDAvis: 0
		});
	});

	it('retirer une consignation non atteinte ne franchit rien', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'a_decouvrir', now: T0 });

		expect(await retirer(db, { membreId, oeuvreId, now: T0 + 1 })).toEqual({
			ok: true,
			franchissement: null,
			noteSupprimee: false,
			avisSupprime: false,
			entreeConservee: false
		});
	});

	it('retirer une consignation inexistante est refusé sans rien casser', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');

		expect(await retirer(db, { membreId, oeuvreId, now: T0 })).toEqual({
			ok: false,
			motif: 'consignation introuvable'
		});
		expect(await franchissementEnAttente(db, membreId, oeuvreId)).toBe(null);
	});
});

describe('position (R23, R24)', () => {
	it('vaut zéro tant que l œuvre n est pas commencée', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1', { type: 'roman' });
		await consigner(db, { membreId, oeuvreId, etagere: 'a_decouvrir', now: T0 });

		expect((await lireConsignation(db, membreId, oeuvreId))?.position).toBe(0);
	});

	it('vaut la dernière valeur déclarée quand l œuvre est en cours', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1', { type: 'roman' });
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 });

		await declarerPosition(db, {
			membreId,
			oeuvreId,
			saisie: { unite: 'pourcentage', valeur: 30 },
			now: T0 + 1
		});
		await declarerPosition(db, {
			membreId,
			oeuvreId,
			saisie: { unite: 'pourcentage', valeur: 55 },
			now: T0 + 2
		});

		expect((await lireConsignation(db, membreId, oeuvreId))?.position).toBe(0.55);
	});

	it('vaut la position totale dès que l œuvre est atteinte, et la retrouve à la reprise', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1', { type: 'roman' });
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId,
			oeuvreId,
			saisie: { unite: 'pourcentage', valeur: 30 },
			now: T0 + 1
		});

		await abandonner(db, { membreId, oeuvreId, now: T0 + 2 });
		expect((await lireConsignation(db, membreId, oeuvreId))?.position).toBe(1);

		await reprendre(db, { membreId, oeuvreId, now: T0 + 3 });
		expect((await lireConsignation(db, membreId, oeuvreId))?.position).toBe(0.3);
	});

	it('une position saisie en pages est stockée en fraction, comparable à un pourcentage', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const enPages = await oeuvre(db, '1', { type: 'roman' });
		const enPourcentage = await oeuvre(db, '2', { type: 'roman' });
		await consigner(db, { membreId, oeuvreId: enPages, etagere: 'en_cours', now: T0 });
		await consigner(db, { membreId, oeuvreId: enPourcentage, etagere: 'en_cours', now: T0 });

		await declarerPosition(db, {
			membreId,
			oeuvreId: enPages,
			saisie: { unite: 'page', valeur: 90, longueurTotale: 300 },
			now: T0 + 1
		});
		await declarerPosition(db, {
			membreId,
			oeuvreId: enPourcentage,
			saisie: { unite: 'pourcentage', valeur: 30 },
			now: T0 + 1
		});

		const a = await lireConsignation(db, membreId, enPages);
		const b = await lireConsignation(db, membreId, enPourcentage);
		expect(a?.position).toBe(b?.position);
		expect(a?.longueurTotale).toBe(300);
	});

	it('retient la longueur déclarée pour les saisies suivantes', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1', { type: 'roman' });
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId,
			oeuvreId,
			saisie: { unite: 'page', valeur: 90, longueurTotale: 300 },
			now: T0 + 1
		});

		await declarerPosition(db, {
			membreId,
			oeuvreId,
			saisie: { unite: 'page', valeur: 150 },
			now: T0 + 2
		});

		expect((await lireConsignation(db, membreId, oeuvreId))?.position).toBe(0.5);
	});

	it('refuse une saisie en pages quand aucune longueur n est connue', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1', { type: 'roman' });
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 });

		expect(
			await declarerPosition(db, {
				membreId,
				oeuvreId,
				saisie: { unite: 'page', valeur: 150 },
				now: T0 + 1
			})
		).toEqual({ ok: false, motif: 'longueur inconnue' });
	});

	it('refuse une position hors bornes sans écraser la précédente', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1', { type: 'roman' });
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId,
			oeuvreId,
			saisie: { unite: 'pourcentage', valeur: 30 },
			now: T0 + 1
		});

		expect(
			await declarerPosition(db, {
				membreId,
				oeuvreId,
				saisie: { unite: 'pourcentage', valeur: 140 },
				now: T0 + 2
			})
		).toEqual({ ok: false, motif: 'hors bornes' });
		expect((await lireConsignation(db, membreId, oeuvreId))?.position).toBe(0.3);
	});

	it('déclarer une position sur une œuvre « à découvrir » la passe en cours', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1', { type: 'roman' });
		await consigner(db, { membreId, oeuvreId, etagere: 'a_decouvrir', now: T0 });

		const resultat = await declarerPosition(db, {
			membreId,
			oeuvreId,
			saisie: { unite: 'pourcentage', valeur: 10 },
			now: T0 + 1
		});

		expect(resultat.ok && resultat.franchissement).toBe(null);
		const entree = await lireConsignation(db, membreId, oeuvreId);
		expect(entree?.etagere).toBe('en_cours');
		expect(entree?.position).toBeCloseTo(0.1);
	});

	it('fige la position de l avis à sa rédaction initiale (R30)', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1', { type: 'roman' });
		await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId,
			oeuvreId,
			saisie: { unite: 'pourcentage', valeur: 40 },
			now: T0 + 1
		});
		const ecrit = await ecrireAvis(db, { membreId, oeuvreId, texte: 'À mi-chemin.', now: T0 + 2 });
		if (!ecrit.ok) throw new Error('avis refusé à tort');

		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 + 3 });
		await modifierAvis(db, {
			membreId,
			avisId: ecrit.avisId,
			texte: 'À mi-chemin (typo).',
			now: T0 + 4
		});

		expect((await lireConsignation(db, membreId, oeuvreId))?.avis?.positionARedaction).toBe(0.4);
	});
});

describe('propriété des avis et des consignations (R37)', () => {
	it('un membre modifie et supprime son propre avis', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });
		const ecrit = await ecrireAvis(db, { membreId, oeuvreId, texte: 'Premier jet.', now: T0 + 1 });
		if (!ecrit.ok) throw new Error('avis refusé à tort');

		expect(
			await modifierAvis(db, { membreId, avisId: ecrit.avisId, texte: 'Relu.', now: T0 + 2 })
		).toEqual({ ok: true, avisId: ecrit.avisId });
		expect((await lireConsignation(db, membreId, oeuvreId))?.avis?.texte).toBe('Relu.');

		expect(await supprimerAvis(db, { membreId, avisId: ecrit.avisId })).toEqual({
			ok: true,
			avisId: ecrit.avisId
		});
		const entree = await lireConsignation(db, membreId, oeuvreId);
		expect(entree?.avis).toBe(null);
		expect(entree?.etagere).toBe('termine');
	});

	it('un membre ne peut ni modifier ni supprimer l avis d un autre', async () => {
		const db = createTestDb();
		const auteur = await membre(db, 'Antoine');
		const intrus = await membre(db, 'Camille');
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId: auteur, oeuvreId, etagere: 'termine', now: T0 });
		const ecrit = await ecrireAvis(db, {
			membreId: auteur,
			oeuvreId,
			texte: 'Le mien.',
			now: T0 + 1
		});
		if (!ecrit.ok) throw new Error('avis refusé à tort');

		expect(
			await modifierAvis(db, {
				membreId: intrus,
				avisId: ecrit.avisId,
				texte: 'Volé.',
				now: T0 + 2
			})
		).toEqual({ ok: false, motif: 'avis introuvable' });
		expect(await supprimerAvis(db, { membreId: intrus, avisId: ecrit.avisId })).toEqual({
			ok: false,
			motif: 'avis introuvable'
		});

		expect((await lireConsignation(db, auteur, oeuvreId))?.avis?.texte).toBe('Le mien.');
	});

	it('un membre ne peut pas retirer la consignation d un autre', async () => {
		const db = createTestDb();
		const auteur = await membre(db, 'Antoine');
		const intrus = await membre(db, 'Camille');
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId: auteur, oeuvreId, etagere: 'termine', now: T0 });

		expect(await retirer(db, { membreId: intrus, oeuvreId, now: T0 + 1 })).toEqual({
			ok: false,
			motif: 'consignation introuvable'
		});
		expect(await lireConsignation(db, auteur, oeuvreId)).not.toBe(null);
	});

	it('un membre ne modifie pas l étagère ni la note d un autre', async () => {
		const db = createTestDb();
		const auteur = await membre(db, 'Antoine');
		const intrus = await membre(db, 'Camille');
		const oeuvreId = await oeuvre(db, '1');
		await consigner(db, { membreId: auteur, oeuvreId, etagere: 'termine', now: T0 });
		await noter(db, { membreId: auteur, oeuvreId, note: 5, now: T0 + 1 });

		await noter(db, { membreId: intrus, oeuvreId, note: 0.5, now: T0 + 2 });
		await consigner(db, { membreId: intrus, oeuvreId, etagere: 'a_decouvrir', now: T0 + 3 });

		const entree = await lireConsignation(db, auteur, oeuvreId);
		expect(entree?.note).toBe(5);
		expect(entree?.etagere).toBe('termine');
	});
});

describe('journal et agrégats (R6, R13)', () => {
	it('le journal d un membre présente ses consignations, ses notes et ses avis', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const autre = await membre(db, 'Camille');
		const un = await oeuvre(db, '1', { titre: 'Giant-Size X-Men 1' });
		const deux = await oeuvre(db, '2', { titre: 'House of X 1' });

		await consigner(db, { membreId, oeuvreId: un, etagere: 'termine', now: T0 });
		await noter(db, { membreId, oeuvreId: un, note: 4.5, now: T0 + 1 });
		await ecrireAvis(db, { membreId, oeuvreId: un, texte: 'Fondateur.', now: T0 + 2 });
		await consigner(db, { membreId, oeuvreId: deux, etagere: 'a_decouvrir', now: T0 + 3 });
		await consigner(db, { membreId: autre, oeuvreId: deux, etagere: 'termine', now: T0 + 4 });

		const journal = await lireJournal(db, membreId);

		expect(journal).toHaveLength(2);
		expect(journal.map((e) => e.oeuvre.titre).sort()).toEqual([
			'Giant-Size X-Men 1',
			'House of X 1'
		]);
		const premier = journal.find((e) => e.oeuvre.id === un);
		expect(premier).toMatchObject({ note: 4.5, atteinte: true, etagere: 'termine' });
		expect(premier?.avis?.texte).toBe('Fondateur.');
	});

	it('le journal affiche le titre corrigé par un membre (R47, R39)', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const oeuvreId = await oeuvre(db, '1', { titre: 'Uncanny X-Men 1' });
		await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });

		await corriger(db, {
			oeuvreId,
			membreId,
			correction: { champ: 'titre', valeur: 'The Uncanny X-Men 1' },
			now: T0 + 1
		});

		expect((await lireJournal(db, membreId))[0].oeuvre.titre).toBe('The Uncanny X-Men 1');
	});

	it('filtre le journal par étagère', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await oeuvre(db, '1');
		const deux = await oeuvre(db, '2');
		await consigner(db, { membreId, oeuvreId: un, etagere: 'termine', now: T0 });
		await consigner(db, { membreId, oeuvreId: deux, etagere: 'a_decouvrir', now: T0 + 1 });

		const aDecouvrir = await lireJournal(db, membreId, { etagere: 'a_decouvrir' });

		expect(aDecouvrir.map((e) => e.oeuvre.id)).toEqual([deux]);
	});

	it('l agrégat d une œuvre porte la moyenne des notes et le nombre d avis', async () => {
		const db = createTestDb();
		const antoine = await membre(db, 'Antoine');
		const camille = await membre(db, 'Camille');
		const lea = await membre(db, 'Léa');
		const oeuvreId = await oeuvre(db, '1');

		for (const [membreId, note] of [
			[antoine, 4],
			[camille, 3]
		] as const) {
			await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });
			await noter(db, { membreId, oeuvreId, note, now: T0 + 1 });
		}
		await consigner(db, { membreId: lea, oeuvreId, etagere: 'en_cours', now: T0 });
		await ecrireAvis(db, { membreId: antoine, oeuvreId, texte: 'Oui.', now: T0 + 2 });

		expect(await agregatDOeuvre(db, oeuvreId)).toEqual({
			noteMoyenne: 3.5,
			nombreDeNotes: 2,
			nombreDAvis: 1
		});
	});

	it('l agrégat d une série reflète les notes de ses numéros', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const un = await oeuvre(db, '1', { serie: 's1', numero: 1 });
		const deux = await oeuvre(db, '2', { serie: 's1', numero: 2 });
		const horsSerie = await oeuvre(db, '3');

		for (const [oeuvreId, note] of [
			[un, 5],
			[deux, 4],
			[horsSerie, 1]
		] as const) {
			await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: T0 });
			await noter(db, { membreId, oeuvreId, note, now: T0 + 1 });
		}

		const ligne = await db.query.works.findFirst({ where: eq(works.id, un) });
		const agregat = await agregatDeSerie(db, ligne!.seriesEntityId!);

		expect(agregat).toEqual({ noteMoyenne: 4.5, nombreDeNotes: 2, nombreDAvis: 0 });
	});

	it('l agrégat d une série ignore la note portée sur la série elle-même', async () => {
		const db = createTestDb();
		const membreId = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 's1', numero: 1 });
		const serie = await oeuvre(db, 's1-oeuvre', { type: 'serie', serie: 's1' });

		await consigner(db, { membreId, oeuvreId: numero, etagere: 'termine', now: T0 });
		await noter(db, { membreId, oeuvreId: numero, note: 5, now: T0 + 1 });
		await consigner(db, { membreId, oeuvreId: serie, etagere: 'termine', now: T0 });
		await noter(db, { membreId, oeuvreId: serie, note: 1, now: T0 + 1 });

		const ligne = await db.query.works.findFirst({ where: eq(works.id, numero) });

		expect(await agregatDeSerie(db, ligne!.seriesEntityId!)).toEqual({
			noteMoyenne: 5,
			nombreDeNotes: 1,
			nombreDAvis: 0
		});
		expect(await agregatDOeuvre(db, serie)).toMatchObject({ noteMoyenne: 1 });
	});
});
