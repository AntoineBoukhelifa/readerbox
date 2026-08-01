import { describe, expect, it } from 'vitest';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import { ingererOeuvre } from '../catalog/ingest';
import { T0, membre, oeuvreDistante } from '../catalog/testing';
import type { TypeOeuvre } from '../catalog/sources/types';
import {
	abandonner,
	consigner,
	declarerPosition,
	ecrireAvis,
	lireAvisDOeuvre,
	lireJournal,
	modifierAvis,
	noter,
	reprendre
} from '../journal/entries';
import {
	estOeuvreLongue,
	estRevelee,
	masquer,
	publicationAutorisee,
	regardsSurOeuvres,
	reveler,
	verdictDeVisibilite,
	type ContenuMasquable,
	type RegardSurOeuvre
} from './visibility';

/** Une œuvre du catalogue, ingérée comme un adaptateur le ferait. */
async function oeuvre(db: Db, idExterne: string, type: TypeOeuvre = 'numero'): Promise<string> {
	const { oeuvreId } = await ingererOeuvre(
		db,
		oeuvreDistante('metron', idExterne, { titre: `Œuvre ${idExterne}`, type }),
		{ now: T0 }
	);
	return oeuvreId;
}

/** Un avis écrit par un membre qui a terminé l’œuvre. */
async function avisDUnLecteurArrive(
	db: Db,
	oeuvreId: string,
	texte: string,
	nom = 'Camille'
): Promise<string> {
	const auteurId = await membre(db, nom);
	await consigner(db, { membreId: auteurId, oeuvreId, etagere: 'termine', now: T0 });
	await ecrireAvis(db, { membreId: auteurId, oeuvreId, texte, now: T0 });
	return auteurId;
}

/** Un regard nu, dont chaque test ne surcharge que ce qu’il éprouve. */
function regard(champs: Partial<RegardSurOeuvre> = {}): RegardSurOeuvre {
	return {
		oeuvreId: 'oeuvre',
		atteinte: false,
		position: 0,
		longue: false,
		revelee: false,
		...champs
	};
}

function contenu(champs: Partial<ContenuMasquable> = {}): ContenuMasquable {
	return {
		id: 'contenu',
		auteurId: 'camille',
		oeuvreId: 'oeuvre',
		texte: 'Le texte',
		positionARedaction: null,
		...champs
	};
}

// ---------------------------------------------------------------------------
// La règle, seule (R27)
// ---------------------------------------------------------------------------

describe('la règle unique (R27)', () => {
	it('masque le texte tant que l’œuvre n’est pas atteinte', () => {
		expect(verdictDeVisibilite(contenu(), regard(), 'antoine')).toEqual({
			visible: false,
			motif: 'œuvre non atteinte'
		});
	});

	it('révèle le texte dès que l’œuvre est atteinte', () => {
		expect(verdictDeVisibilite(contenu(), regard({ atteinte: true }), 'antoine')).toEqual({
			visible: true,
			motif: 'atteinte'
		});
	});

	it('ne consulte ni l’étagère ni la note : seule l’atteinte compte', () => {
		// Un membre qui a l’œuvre « en cours » depuis un an et l’a notée reste
		// exactement aussi masqué qu’un membre qui ne l’a jamais consignée.
		const enCours = regard({ atteinte: false, position: 0.99 });
		expect(verdictDeVisibilite(contenu(), enCours, 'antoine').visible).toBe(false);
	});

	it('un membre voit toujours son propre texte, quelle que soit sa position', () => {
		const sien = contenu({ auteurId: 'antoine' });
		expect(verdictDeVisibilite(sien, regard(), 'antoine')).toEqual({
			visible: true,
			motif: 'auteur'
		});
	});
});

describe('la condition intra-œuvre (R29)', () => {
	it('masque un contenu écrit plus loin que le lecteur', () => {
		const commentaire = contenu({ positionARedaction: 0.7 });
		const lecteur = regard({ longue: true, position: 0.3 });

		expect(verdictDeVisibilite(commentaire, lecteur, 'antoine')).toEqual({
			visible: false,
			motif: 'position dépassée'
		});
	});

	it('laisse voir un contenu écrit en deçà de la position du lecteur', () => {
		const commentaire = contenu({ positionARedaction: 0.2 });
		const lecteur = regard({ longue: true, position: 0.3 });

		expect(verdictDeVisibilite(commentaire, lecteur, 'antoine')).toEqual({
			visible: true,
			motif: 'position'
		});
	});

	it('laisse voir un contenu écrit exactement à la position du lecteur', () => {
		const commentaire = contenu({ positionARedaction: 0.3 });
		const lecteur = regard({ longue: true, position: 0.3 });

		expect(verdictDeVisibilite(commentaire, lecteur, 'antoine').visible).toBe(true);
	});

	it('ne s’applique qu’aux œuvres longues : un numéro n’a pas d’intérieur', () => {
		// Sans ce garde-fou, un avis écrit sur un numéro « à découvrir » — donc à
		// la position zéro — serait visible de tout le groupe, puisque tout le
		// monde est au moins à zéro.
		const avis = contenu({ positionARedaction: 0 });
		const lecteur = regard({ longue: false, position: 0 });

		expect(verdictDeVisibilite(avis, lecteur, 'antoine').visible).toBe(false);
	});

	it('masque un contenu sans position enregistrée, plutôt que de deviner', () => {
		const commentaire = contenu({ positionARedaction: null });
		const lecteur = regard({ longue: true, position: 1 });

		expect(verdictDeVisibilite(commentaire, lecteur, 'antoine').visible).toBe(false);
	});
});

describe('les œuvres longues', () => {
	it('sont le recueil et le roman, jamais le numéro ni le film', () => {
		expect(estOeuvreLongue('recueil')).toBe(true);
		expect(estOeuvreLongue('roman')).toBe(true);
		expect(estOeuvreLongue('numero')).toBe(false);
		expect(estOeuvreLongue('film')).toBe(false);
		expect(estOeuvreLongue('serie')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// La règle sur la base
// ---------------------------------------------------------------------------

describe('masquer (AE1, AE2)', () => {
	it('AE1 — un membre qui n’a pas atteint l’œuvre ne reçoit pas le texte', async () => {
		const db = createTestDb();
		const oeuvreId = await oeuvre(db, '1');
		await avisDUnLecteurArrive(db, oeuvreId, 'Le vilain meurt à la fin.');
		const lecteurId = await membre(db, 'Antoine');
		await consigner(db, { membreId: lecteurId, oeuvreId, etagere: 'en_cours', now: T0 });

		const [vu] = await masquer(db, lecteurId, await lireAvisDOeuvre(db, oeuvreId));

		expect(vu.masque).toBe(true);
		expect(vu.texte).toBe(null);
	});

	it('AE2 — abandonner l’œuvre rend tous ses textes visibles', async () => {
		const db = createTestDb();
		const oeuvreId = await oeuvre(db, '1');
		await avisDUnLecteurArrive(db, oeuvreId, 'Le vilain meurt à la fin.', 'Camille');
		await avisDUnLecteurArrive(db, oeuvreId, 'Et le héros aussi.', 'Dominique');
		const lecteurId = await membre(db, 'Antoine');
		await consigner(db, { membreId: lecteurId, oeuvreId, etagere: 'en_cours', now: T0 });

		const avant = await masquer(db, lecteurId, await lireAvisDOeuvre(db, oeuvreId));
		expect(avant.every((vu) => vu.masque)).toBe(true);

		await abandonner(db, { membreId: lecteurId, oeuvreId, now: T0 + 1 });

		const apres = await masquer(db, lecteurId, await lireAvisDOeuvre(db, oeuvreId));
		expect(apres.map((vu) => vu.texte).sort()).toEqual([
			'Et le héros aussi.',
			'Le vilain meurt à la fin.'
		]);
	});

	it('R35 — reprendre une œuvre abandonnée re-masque ses textes', async () => {
		const db = createTestDb();
		const oeuvreId = await oeuvre(db, '1');
		await avisDUnLecteurArrive(db, oeuvreId, 'Le vilain meurt à la fin.');
		const lecteurId = await membre(db, 'Antoine');
		await consigner(db, { membreId: lecteurId, oeuvreId, etagere: 'en_cours', now: T0 });
		await abandonner(db, { membreId: lecteurId, oeuvreId, now: T0 + 1 });
		await reprendre(db, { membreId: lecteurId, oeuvreId, now: T0 + 2 });

		const [vu] = await masquer(db, lecteurId, await lireAvisDOeuvre(db, oeuvreId));

		expect(vu.texte).toBe(null);
	});

	it('AE12 — à 30 % d’un omnibus non atteint, un commentaire écrit à 70 % reste masqué', async () => {
		const db = createTestDb();
		const omnibus = await oeuvre(db, 'omnibus', 'recueil');

		const auteurId = await membre(db, 'Camille');
		await consigner(db, { membreId: auteurId, oeuvreId: omnibus, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId: auteurId,
			oeuvreId: omnibus,
			saisie: { unite: 'pourcentage', valeur: 70 },
			now: T0
		});
		await ecrireAvis(db, {
			membreId: auteurId,
			oeuvreId: omnibus,
			texte: 'Ce qui arrive au tome cinq change tout.',
			now: T0
		});

		const lecteurId = await membre(db, 'Antoine');
		await consigner(db, { membreId: lecteurId, oeuvreId: omnibus, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId: lecteurId,
			oeuvreId: omnibus,
			saisie: { unite: 'pourcentage', valeur: 30 },
			now: T0
		});

		const [vu] = await masquer(db, lecteurId, await lireAvisDOeuvre(db, omnibus));

		expect(vu.masque).toBe(true);
		expect(vu.texte).toBe(null);
	});

	it('à 30 % d’un omnibus, un commentaire écrit à 20 % est lisible', async () => {
		const db = createTestDb();
		const omnibus = await oeuvre(db, 'omnibus', 'recueil');

		const auteurId = await membre(db, 'Camille');
		await consigner(db, { membreId: auteurId, oeuvreId: omnibus, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId: auteurId,
			oeuvreId: omnibus,
			saisie: { unite: 'pourcentage', valeur: 20 },
			now: T0
		});
		await ecrireAvis(db, {
			membreId: auteurId,
			oeuvreId: omnibus,
			texte: 'Les cent premières pages sont laborieuses.',
			now: T0
		});

		const lecteurId = await membre(db, 'Antoine');
		await consigner(db, { membreId: lecteurId, oeuvreId: omnibus, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId: lecteurId,
			oeuvreId: omnibus,
			saisie: { unite: 'pourcentage', valeur: 30 },
			now: T0
		});

		const [vu] = await masquer(db, lecteurId, await lireAvisDOeuvre(db, omnibus));

		expect(vu.texte).toBe('Les cent premières pages sont laborieuses.');
	});

	it('une position saisie en pages se compare à une position saisie en pourcentage', async () => {
		const db = createTestDb();
		const roman = await oeuvre(db, 'roman', 'roman');

		const auteurId = await membre(db, 'Camille');
		await consigner(db, { membreId: auteurId, oeuvreId: roman, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId: auteurId,
			oeuvreId: roman,
			saisie: { unite: 'page', valeur: 100, longueurTotale: 400 },
			now: T0
		});
		await ecrireAvis(db, { membreId: auteurId, oeuvreId: roman, texte: 'Au quart.', now: T0 });

		const lecteurId = await membre(db, 'Antoine');
		await consigner(db, { membreId: lecteurId, oeuvreId: roman, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId: lecteurId,
			oeuvreId: roman,
			saisie: { unite: 'pourcentage', valeur: 50 },
			now: T0
		});

		const [vu] = await masquer(db, lecteurId, await lireAvisDOeuvre(db, roman));

		expect(vu.texte).toBe('Au quart.');
	});

	it('un membre sans aucune consignation est au point zéro, pas hors règle', async () => {
		const db = createTestDb();
		const omnibus = await oeuvre(db, 'omnibus', 'recueil');
		const auteurId = await membre(db, 'Camille');
		await consigner(db, { membreId: auteurId, oeuvreId: omnibus, etagere: 'termine', now: T0 });
		await ecrireAvis(db, { membreId: auteurId, oeuvreId: omnibus, texte: 'Formidable.', now: T0 });

		const inconnuId = await membre(db, 'Antoine');
		const [vu] = await masquer(db, inconnuId, await lireAvisDOeuvre(db, omnibus));

		expect(vu.texte).toBe(null);
	});

	it('un membre voit toujours ses propres textes, même sur une œuvre non atteinte', async () => {
		const db = createTestDb();
		const oeuvreId = await oeuvre(db, '1');
		const membreId = await membre(db, 'Antoine');
		await consigner(db, { membreId, oeuvreId, etagere: 'a_decouvrir', now: T0 });
		await ecrireAvis(db, { membreId, oeuvreId, texte: 'Je le note d’avance.', now: T0 });

		const [vu] = await masquer(db, membreId, await lireAvisDOeuvre(db, oeuvreId));

		expect(vu.masque).toBe(false);
		expect(vu.texte).toBe('Je le note d’avance.');
	});

	it('rend un verdict par œuvre, sans mélanger deux œuvres du même lot', async () => {
		const db = createTestDb();
		const atteinte = await oeuvre(db, '1');
		const nonAtteinte = await oeuvre(db, '2');
		await avisDUnLecteurArrive(db, atteinte, 'Texte de la lue.');
		await avisDUnLecteurArrive(db, nonAtteinte, 'Texte de l’autre.', 'Dominique');

		const lecteurId = await membre(db, 'Antoine');
		await consigner(db, { membreId: lecteurId, oeuvreId: atteinte, etagere: 'termine', now: T0 });

		const contenus = [
			...(await lireAvisDOeuvre(db, atteinte)),
			...(await lireAvisDOeuvre(db, nonAtteinte))
		];
		const vus = await masquer(db, lecteurId, contenus);

		expect(vus.map((vu) => vu.texte)).toEqual(['Texte de la lue.', null]);
	});

	it('ne rend aucun texte quand on ne lui donne rien à masquer', async () => {
		const db = createTestDb();
		const lecteurId = await membre(db, 'Antoine');

		expect(await masquer(db, lecteurId, [])).toEqual([]);
	});
});

describe('regardsSurOeuvres', () => {
	it('donne la position effective de R24, pas la position déclarée', async () => {
		const db = createTestDb();
		const omnibus = await oeuvre(db, 'omnibus', 'recueil');
		const membreId = await membre(db, 'Antoine');
		await consigner(db, { membreId, oeuvreId: omnibus, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId,
			oeuvreId: omnibus,
			saisie: { unite: 'pourcentage', valeur: 30 },
			now: T0
		});
		await consigner(db, { membreId, oeuvreId: omnibus, etagere: 'termine', now: T0 + 1 });

		const regards = await regardsSurOeuvres(db, membreId, [omnibus]);

		// R24 — la position d’une œuvre atteinte est totale, quelle que soit la
		// dernière valeur déclarée.
		expect(regards.get(omnibus)).toEqual({
			oeuvreId: omnibus,
			atteinte: true,
			position: 1,
			longue: true,
			revelee: false
		});
	});
});

// ---------------------------------------------------------------------------
// La révélation (R31, AE15)
// ---------------------------------------------------------------------------

describe('la révélation (R31, AE15)', () => {
	it('AE15 — un contenu révélé le reste, et la révélation ne vaut que pour ce membre', async () => {
		const db = createTestDb();
		const oeuvreId = await oeuvre(db, '1');
		await avisDUnLecteurArrive(db, oeuvreId, 'Le vilain meurt à la fin.');
		const lecteurId = await membre(db, 'Antoine');
		const voisinId = await membre(db, 'Dominique');

		await reveler(db, { membreId: lecteurId, oeuvreId, now: T0 });

		// Rechargement : rien n’est conservé en mémoire entre deux requêtes.
		const [vu] = await masquer(db, lecteurId, await lireAvisDOeuvre(db, oeuvreId));
		expect(vu.texte).toBe('Le vilain meurt à la fin.');
		expect(vu.masque).toBe(false);

		const [pourLeVoisin] = await masquer(db, voisinId, await lireAvisDOeuvre(db, oeuvreId));
		expect(pourLeVoisin.texte).toBe(null);
	});

	it('vaut pour cette œuvre seulement, jamais pour le voisinage', async () => {
		const db = createTestDb();
		const revelee = await oeuvre(db, '1');
		const autre = await oeuvre(db, '2');
		await avisDUnLecteurArrive(db, revelee, 'Texte révélé.');
		await avisDUnLecteurArrive(db, autre, 'Texte voisin.', 'Dominique');
		const lecteurId = await membre(db, 'Antoine');

		await reveler(db, { membreId: lecteurId, oeuvreId: revelee, now: T0 });

		const [surLAutre] = await masquer(db, lecteurId, await lireAvisDOeuvre(db, autre));
		expect(surLAutre.texte).toBe(null);
	});

	it('révéler deux fois est sans effet', async () => {
		const db = createTestDb();
		const oeuvreId = await oeuvre(db, '1');
		const membreId = await membre(db, 'Antoine');

		await reveler(db, { membreId, oeuvreId, now: T0 });
		await reveler(db, { membreId, oeuvreId, now: T0 + 1000 });

		expect(await estRevelee(db, membreId, oeuvreId)).toBe(true);
	});

	it('la révélation d’un membre n’est pas lisible depuis un autre identifiant', async () => {
		const db = createTestDb();
		const oeuvreId = await oeuvre(db, '1');
		const lecteurId = await membre(db, 'Antoine');
		const voisinId = await membre(db, 'Dominique');

		await reveler(db, { membreId: lecteurId, oeuvreId, now: T0 });

		expect(await estRevelee(db, voisinId, oeuvreId)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// La position obligatoire (R25) et son gel (R30)
// ---------------------------------------------------------------------------

describe('R25 — déclarer sa position avant de publier', () => {
	it('refuse un avis sur une œuvre longue non atteinte sans position déclarée', async () => {
		const db = createTestDb();
		const omnibus = await oeuvre(db, 'omnibus', 'recueil');
		const membreId = await membre(db, 'Antoine');
		await consigner(db, { membreId, oeuvreId: omnibus, etagere: 'en_cours', now: T0 });

		const resultat = await ecrireAvis(db, {
			membreId,
			oeuvreId: omnibus,
			texte: 'Un mot avant la fin.',
			now: T0
		});

		expect(resultat).toEqual({ ok: false, motif: 'position requise' });
	});

	it('accepte le même avis une fois la position déclarée', async () => {
		const db = createTestDb();
		const omnibus = await oeuvre(db, 'omnibus', 'recueil');
		const membreId = await membre(db, 'Antoine');
		await consigner(db, { membreId, oeuvreId: omnibus, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId,
			oeuvreId: omnibus,
			saisie: { unite: 'pourcentage', valeur: 40 },
			now: T0
		});

		const resultat = await ecrireAvis(db, {
			membreId,
			oeuvreId: omnibus,
			texte: 'Un mot avant la fin.',
			now: T0
		});

		expect(resultat.ok).toBe(true);
	});

	it('n’exige rien sur une œuvre longue atteinte', async () => {
		const db = createTestDb();
		const omnibus = await oeuvre(db, 'omnibus', 'recueil');
		const membreId = await membre(db, 'Antoine');
		await consigner(db, { membreId, oeuvreId: omnibus, etagere: 'termine', now: T0 });

		const resultat = await ecrireAvis(db, {
			membreId,
			oeuvreId: omnibus,
			texte: 'Tout lu.',
			now: T0
		});

		expect(resultat.ok).toBe(true);
	});

	it('n’exige rien sur une œuvre qui n’est pas longue', async () => {
		const db = createTestDb();
		const numero = await oeuvre(db, '1');
		const membreId = await membre(db, 'Antoine');
		await consigner(db, { membreId, oeuvreId: numero, etagere: 'a_decouvrir', now: T0 });

		const resultat = await ecrireAvis(db, {
			membreId,
			oeuvreId: numero,
			texte: 'Vu la couverture.',
			now: T0
		});

		expect(resultat.ok).toBe(true);
	});

	it('la règle est la même, lue depuis sa fonction pure', () => {
		expect(
			publicationAutorisee({ typeOeuvre: 'recueil', atteinte: false, positionDeclaree: null })
		).toBe(false);
		expect(
			publicationAutorisee({ typeOeuvre: 'recueil', atteinte: false, positionDeclaree: 0.4 })
		).toBe(true);
		expect(
			publicationAutorisee({ typeOeuvre: 'recueil', atteinte: true, positionDeclaree: null })
		).toBe(true);
		expect(
			publicationAutorisee({ typeOeuvre: 'numero', atteinte: false, positionDeclaree: null })
		).toBe(true);
	});

	it('refuse la position zéro : publier là serait lisible de tous sans rien avoir atteint', () => {
		// Sous R29 un contenu est visible à qui est au moins à sa position, et tout
		// lecteur est au moins à zéro. Sans cette borne, écrire à zéro contournerait
		// tout le dispositif de masquage.
		expect(
			publicationAutorisee({ typeOeuvre: 'recueil', atteinte: false, positionDeclaree: 0 })
		).toBe(false);
		expect(
			publicationAutorisee({ typeOeuvre: 'roman', atteinte: false, positionDeclaree: 0 })
		).toBe(false);
	});

	it('accepte la plus petite position strictement positive', () => {
		expect(
			publicationAutorisee({ typeOeuvre: 'roman', atteinte: false, positionDeclaree: 0.001 })
		).toBe(true);
	});
});

describe('R30 — la position est figée à la rédaction initiale', () => {
	it('modifier un avis après avoir avancé ne change pas sa position enregistrée', async () => {
		const db = createTestDb();
		const omnibus = await oeuvre(db, 'omnibus', 'recueil');

		const auteurId = await membre(db, 'Camille');
		await consigner(db, { membreId: auteurId, oeuvreId: omnibus, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId: auteurId,
			oeuvreId: omnibus,
			saisie: { unite: 'pourcentage', valeur: 20 },
			now: T0
		});
		const ecrit = await ecrireAvis(db, {
			membreId: auteurId,
			oeuvreId: omnibus,
			texte: 'Un début poussif.',
			now: T0
		});

		// L’auteur avance, puis corrige sa faute de frappe.
		await declarerPosition(db, {
			membreId: auteurId,
			oeuvreId: omnibus,
			saisie: { unite: 'pourcentage', valeur: 90 },
			now: T0 + 1
		});
		await modifierAvis(db, {
			membreId: auteurId,
			avisId: ecrit.ok ? ecrit.avisId : '',
			texte: 'Un début poussif, mais ça décolle.',
			now: T0 + 2
		});

		const [contenuRelu] = await lireAvisDOeuvre(db, omnibus);
		expect(contenuRelu.positionARedaction).toBe(0.2);

		// Et la conséquence, qui est la raison d’être de la règle : un lecteur à
		// 30 % qui avait déjà lu ce texte ne le voit pas se re-masquer.
		const lecteurId = await membre(db, 'Antoine');
		await consigner(db, { membreId: lecteurId, oeuvreId: omnibus, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId: lecteurId,
			oeuvreId: omnibus,
			saisie: { unite: 'pourcentage', valeur: 30 },
			now: T0
		});

		const [vu] = await masquer(db, lecteurId, await lireAvisDOeuvre(db, omnibus));
		expect(vu.texte).toBe('Un début poussif, mais ça décolle.');
	});
});

// ---------------------------------------------------------------------------
// Ce que le masquage ne touche jamais (R28)
// ---------------------------------------------------------------------------

describe('R28 — les notes ne sont jamais masquées', () => {
	it('la note de l’auteur accompagne un avis masqué', async () => {
		const db = createTestDb();
		const oeuvreId = await oeuvre(db, '1');
		const auteurId = await avisDUnLecteurArrive(db, oeuvreId, 'Le vilain meurt à la fin.');
		await noter(db, { membreId: auteurId, oeuvreId, note: 4.5, now: T0 });
		const lecteurId = await membre(db, 'Antoine');

		const [vu] = await masquer(db, lecteurId, await lireAvisDOeuvre(db, oeuvreId));

		expect(vu.texte).toBe(null);
		expect(vu.note).toBe(4.5);
		expect(vu.auteurNom).toBe('Camille');
	});

	it('le journal d’un membre reste lisible en tant qu’objet : l’avis existe et il est signé', async () => {
		const db = createTestDb();
		const oeuvreId = await oeuvre(db, '1');
		const auteurId = await avisDUnLecteurArrive(db, oeuvreId, 'Le vilain meurt à la fin.');
		const lecteurId = await membre(db, 'Antoine');

		const journal = await lireJournal(db, auteurId);
		const contenus = journal.flatMap((entree) =>
			entree.avis === null
				? []
				: [
						{
							id: entree.avis.id,
							auteurId: entree.membreId,
							oeuvreId: entree.oeuvre.id,
							texte: entree.avis.texte,
							positionARedaction: entree.avis.positionARedaction
						}
					]
		);
		const [vu] = await masquer(db, lecteurId, contenus);

		expect(vu.masque).toBe(true);
		expect(vu.texte).toBe(null);
		// R31 — on sait qu’il existe et qui l’a écrit.
		expect(vu.id).toBe(journal[0].avis?.id);
		expect(vu.auteurId).toBe(auteurId);
	});
});
