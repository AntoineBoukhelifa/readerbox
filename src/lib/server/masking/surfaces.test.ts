import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import { members, type Member } from '../db/schema';
import { eq } from 'drizzle-orm';
import { ingererOeuvre } from '../catalog/ingest';
import { T0, oeuvreDistante } from '../catalog/testing';
import type { TypeOeuvre } from '../catalog/sources/types';
import { consigner, declarerPosition, ecrireAvis, noter } from '../journal/entries';

/**
 * Les surfaces, éprouvées sur ce qu’elles envoient réellement.
 *
 * Ce fichier ne teste pas la règle — `visibility.test.ts` s’en charge — mais le
 * fait qu’**aucune surface n’y déroge**. Le défaut que KTD5 existe pour éviter
 * n’est pas une règle fausse, c’est une règle juste qu’une page a réimplémentée
 * de son côté. Il ne se voit donc qu’ici : dans la charge utile.
 *
 * La base de test est injectée par substitution de `getDb`, parce que les routes
 * la prennent de `platform.env.DB` — un D1 que nous n’avons pas sous la main.
 * Tout le reste des routes s’exécute tel quel, y compris la sérialisation.
 */
const contexte = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('$lib/server/db', async (importOriginal) => {
	const original = await importOriginal<typeof import('../db')>();
	return { ...original, getDb: () => contexte.db };
});

const { load: chargerOeuvre, actions: actionsOeuvre } =
	await import('../../../routes/work/[id]/+page.server');
const { load: chargerMembre, actions: actionsMembre } =
	await import('../../../routes/member/[id]/+page.server');

let db: Db;

beforeEach(() => {
	db = createTestDb();
	contexte.db = db;
});

// ---------------------------------------------------------------------------
// Le harnais de route
// ---------------------------------------------------------------------------

/** Un membre, et la ligne complète que `locals.member` porte. */
async function membre(nom: string): Promise<Member> {
	const [ligne] = await db.insert(members).values({ displayName: nom, createdAt: T0 }).returning();
	return ligne;
}

async function oeuvre(idExterne: string, type: TypeOeuvre = 'numero'): Promise<string> {
	const { oeuvreId } = await ingererOeuvre(
		db,
		oeuvreDistante('metron', idExterne, { titre: `Œuvre ${idExterne}`, type }),
		{ now: T0 }
	);
	return oeuvreId;
}

/**
 * Un événement de requête réduit à ce que les routes lisent.
 *
 * `platform.env.DB` n’a qu’à être présent : c’est `getDb`, substitué plus haut,
 * qui rend la base de test.
 */
function evenement<T>(
	membreConnecte: Member | null,
	params: Record<string, string>,
	champs: Record<string, string> = {},
	requete = ''
): T {
	const corps = new FormData();
	for (const [nom, valeur] of Object.entries(champs)) corps.set(nom, valeur);

	return {
		params,
		url: new URL(`http://localhost/${requete}`),
		locals: { member: membreConnecte },
		platform: { env: { DB: {} } },
		request: new Request('http://localhost/', { method: 'POST', body: corps })
	} as unknown as T;
}

/**
 * La charge utile, débarrassée du `void` que le type de SvelteKit admet.
 *
 * Une fonction `load` a le droit de ne rien rendre ; les nôtres rendent
 * toujours quelque chose, et c'est ce quelque chose qu'on inspecte.
 */
function utile<T>(charge: T): Exclude<T, void> {
	return charge as Exclude<T, void>;
}

/**
 * Toutes les chaînes de la charge utile, quelle que soit leur profondeur.
 *
 * `JSON.stringify` ne suffirait pas : SvelteKit sérialise avec devalue, qui
 * traverse aussi les `Map`, les `Set` et les valeurs que JSON laisse tomber. Un
 * texte caché dans une clé de `Map` partirait quand même dans la réponse.
 */
function chaines(valeur: unknown, vues = new Set<unknown>()): string[] {
	if (typeof valeur === 'string') return [valeur];
	if (valeur === null || typeof valeur !== 'object') return [];
	if (vues.has(valeur)) return [];
	vues.add(valeur);

	if (Array.isArray(valeur)) return valeur.flatMap((element) => chaines(element, vues));
	if (valeur instanceof Map) {
		return [...valeur.entries()].flatMap(([cle, val]) => [
			...chaines(cle, vues),
			...chaines(val, vues)
		]);
	}
	if (valeur instanceof Set) return [...valeur].flatMap((element) => chaines(element, vues));

	return Object.entries(valeur).flatMap(([cle, val]) => [cle, ...chaines(val, vues)]);
}

const SPOILER = 'Le vilain est en réalité son père.';

/** Une œuvre, un avis d’un membre qui l’a atteinte, et un lecteur qui ne l’a pas atteinte. */
async function scene(type: TypeOeuvre = 'numero') {
	const oeuvreId = await oeuvre('1', type);
	const auteur = await membre('Camille');
	const lecteur = await membre('Antoine');

	await consigner(db, { membreId: auteur.id, oeuvreId, etagere: 'termine', now: T0 });
	await noter(db, { membreId: auteur.id, oeuvreId, note: 4.5, now: T0 });
	await ecrireAvis(db, { membreId: auteur.id, oeuvreId, texte: SPOILER, now: T0 });

	return { oeuvreId, auteur, lecteur };
}

// ---------------------------------------------------------------------------
// AE1 — la charge utile brute
// ---------------------------------------------------------------------------

describe('page d’œuvre (AE1, AE3)', () => {
	it('AE1 — le texte masqué n’est nulle part dans la charge utile de la réponse', async () => {
		const { oeuvreId, lecteur } = await scene();
		await consigner(db, { membreId: lecteur.id, oeuvreId, etagere: 'en_cours', now: T0 });

		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));

		expect(chaines(charge)).not.toContain(SPOILER);
		expect(JSON.stringify(charge)).not.toContain('son père');
	});

	it('l’avis reste un objet : on sait qu’il existe et qui l’a écrit (R31)', async () => {
		const { oeuvreId, auteur, lecteur } = await scene();

		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));

		expect(charge.avis).toHaveLength(1);
		expect(charge.avis[0]).toMatchObject({
			masque: true,
			texte: null,
			auteur: { id: auteur.id, nom: 'Camille' },
			note: 4.5
		});
	});

	it('AE3 — la note agrégée et le nombre d’avis s’affichent malgré le masquage', async () => {
		const { oeuvreId, lecteur } = await scene();

		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));

		expect(charge.agregat).toEqual({ noteMoyenne: 4.5, nombreDeNotes: 1, nombreDAvis: 1 });
		expect(charge.avis[0].texte).toBe(null);
	});

	it('sert le texte au membre qui a atteint l’œuvre', async () => {
		const { oeuvreId, lecteur } = await scene();
		await consigner(db, { membreId: lecteur.id, oeuvreId, etagere: 'termine', now: T0 + 1 });

		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));

		expect(charge.avis[0].texte).toBe(SPOILER);
		expect(chaines(charge)).toContain(SPOILER);
	});

	it('R26 — montre qui du groupe a atteint l’œuvre et où en sont les autres', async () => {
		const omnibus = await oeuvre('omnibus', 'recueil');
		const arrivee = await membre('Camille');
		const enRoute = await membre('Antoine');

		await consigner(db, { membreId: arrivee.id, oeuvreId: omnibus, etagere: 'termine', now: T0 });
		await consigner(db, { membreId: enRoute.id, oeuvreId: omnibus, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId: enRoute.id,
			oeuvreId: omnibus,
			saisie: { unite: 'pourcentage', valeur: 30 },
			now: T0
		});

		const charge = utile(await chargerOeuvre(evenement(enRoute, { id: omnibus })));

		expect(charge.lecteurs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ nom: 'Camille', atteinte: true, position: 1 }),
				expect.objectContaining({ nom: 'Antoine', atteinte: false, position: 0.3 })
			])
		);
	});

	it('refuse la page sans session', async () => {
		const { oeuvreId } = await scene();

		await expect(chargerOeuvre(evenement(null, { id: oeuvreId }))).rejects.toMatchObject({
			status: 401
		});
	});

	it('rend 404 sur une œuvre inconnue plutôt que de rendre une page vide', async () => {
		const { lecteur } = await scene();

		await expect(chargerOeuvre(evenement(lecteur, { id: 'inexistante' }))).rejects.toMatchObject({
			status: 404
		});
	});
});

// ---------------------------------------------------------------------------
// La page de profil
// ---------------------------------------------------------------------------

describe('page de profil', () => {
	it('AE1 — le texte masqué n’est pas dans la charge utile du journal d’un autre', async () => {
		const { auteur, lecteur } = await scene();

		const charge = utile(await chargerMembre(evenement(lecteur, { id: auteur.id })));

		expect(chaines(charge)).not.toContain(SPOILER);
		expect(charge.entrees[0].avis).toMatchObject({ masque: true, texte: null });
	});

	it('sert le texte au membre qui a atteint l’œuvre — R27 est plus large que « son propre avis »', async () => {
		const { oeuvreId, auteur, lecteur } = await scene();
		await consigner(db, { membreId: lecteur.id, oeuvreId, etagere: 'termine', now: T0 + 1 });

		const charge = utile(await chargerMembre(evenement(lecteur, { id: auteur.id })));

		expect(charge.entrees[0].avis).toMatchObject({ masque: false, texte: SPOILER });
	});

	it('sert toujours à un membre ses propres textes', async () => {
		const { oeuvreId, auteur } = await scene();
		// Même sur une œuvre qu’il n’a pas atteinte.
		const autre = await oeuvre('2');
		await consigner(db, { membreId: auteur.id, oeuvreId: autre, etagere: 'a_decouvrir', now: T0 });
		await ecrireAvis(db, { membreId: auteur.id, oeuvreId: autre, texte: 'Mon mot.', now: T0 });

		const charge = utile(await chargerMembre(evenement(auteur, { id: auteur.id })));
		const entrees: { avis: { texte: string | null } | null }[] = charge.entrees;
		const textes = entrees.map((entree) => entree.avis?.texte);

		expect(textes).toContain('Mon mot.');
		expect(textes).toContain(SPOILER);
		expect(oeuvreId).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// La révélation, aller-retour serveur (R31, AE15)
// ---------------------------------------------------------------------------

describe('la révélation est un aller-retour serveur (R31, AE15)', () => {
	it('AE15 — le texte n’arrive qu’après la révélation, et il reste là au rechargement', async () => {
		const { oeuvreId, lecteur } = await scene();

		const avant = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(chaines(avant)).not.toContain(SPOILER);

		await actionsOeuvre.reveler(evenement(lecteur, { id: oeuvreId }, { oeuvre: oeuvreId }));

		const apres = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(apres.avis[0].texte).toBe(SPOILER);

		// Rechargement plus tard : la révélation persiste.
		const bienApres = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(bienApres.avis[0].texte).toBe(SPOILER);
	});

	it('la révélation d’un membre n’ouvre rien chez un autre', async () => {
		const { oeuvreId, lecteur } = await scene();
		const voisin = await membre('Dominique');

		await actionsOeuvre.reveler(evenement(lecteur, { id: oeuvreId }, { oeuvre: oeuvreId }));

		const charge = utile(await chargerOeuvre(evenement(voisin, { id: oeuvreId })));
		expect(chaines(charge)).not.toContain(SPOILER);
	});

	it('un membre ne peut pas révéler au nom d’un autre par manipulation d’identifiant', async () => {
		const { oeuvreId, lecteur } = await scene();
		const voisin = await membre('Dominique');

		// Le voisin poste tout ce qu’il peut forger : l’identifiant du lecteur y
		// compris. Seule la session compte.
		await actionsOeuvre.reveler(
			evenement(voisin, { id: oeuvreId }, { oeuvre: oeuvreId, membre: lecteur.id })
		);

		const chezLeLecteur = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(chaines(chezLeLecteur)).not.toContain(SPOILER);
	});

	it('refuse la révélation sans session', async () => {
		const { oeuvreId } = await scene();

		const resultat = await actionsOeuvre.reveler(
			evenement(null, { id: oeuvreId }, { oeuvre: oeuvreId })
		);

		expect(resultat).toMatchObject({ status: 401 });
	});

	it('la page de profil révèle par la même mécanique', async () => {
		const { oeuvreId, auteur, lecteur } = await scene();

		await actionsMembre.reveler(evenement(lecteur, { id: auteur.id }, { oeuvre: oeuvreId }));

		const charge = utile(await chargerMembre(evenement(lecteur, { id: auteur.id })));
		expect(charge.entrees[0].avis).toMatchObject({ masque: false, texte: SPOILER });
	});
});

// ---------------------------------------------------------------------------
// Le même verdict partout (KTD5)
// ---------------------------------------------------------------------------

describe('le même verdict sur toutes les surfaces (KTD5)', () => {
	it('page d’œuvre, page de profil et journal s’accordent sur le même couple membre-œuvre', async () => {
		const { oeuvreId, auteur, lecteur } = await scene('recueil');

		for (const attendu of [false, true]) {
			if (attendu) {
				await consigner(db, { membreId: lecteur.id, oeuvreId, etagere: 'termine', now: T0 + 1 });
			}

			const pageDOeuvre = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
			const pageDeProfil = utile(await chargerMembre(evenement(lecteur, { id: auteur.id })));

			const surLOeuvre = pageDOeuvre.avis[0];
			const surLeProfil = pageDeProfil.entrees[0].avis;

			expect(surLOeuvre.masque).toBe(!attendu);
			expect(surLeProfil?.masque).toBe(!attendu);
			expect(surLOeuvre.texte).toBe(surLeProfil?.texte ?? null);
			expect(surLOeuvre.id).toBe(surLeProfil?.id);
		}
	});
});

// ---------------------------------------------------------------------------
// Le garde-fou d’architecture (KTD5)
// ---------------------------------------------------------------------------

/**
 * Ces deux tests ne vérifient pas un comportement mais une **forme**, et c’est
 * délibéré : le défaut cité chez Goodreads n’est pas une règle fausse, c’est un
 * masquage réimplémenté par surface. Aucun test de comportement ne l’attrape,
 * puisqu’il porte sur la surface qu’on a justement oublié d’écrire.
 */
describe('aucune surface ne contourne la règle (KTD5)', () => {
	/** Les fichiers de `src`, sauf les tests eux-mêmes. */
	function fichiersSources(racine: string): string[] {
		return readdirSync(racine, { withFileTypes: true }).flatMap((entree) => {
			const chemin = join(racine, entree.name);
			if (entree.isDirectory()) return fichiersSources(chemin);
			if (!/\.(ts|svelte)$/.test(entree.name) || /\.test\.ts$/.test(entree.name)) return [];
			return [chemin];
		});
	}

	const RACINE = join(process.cwd(), 'src');
	const MASQUAGE = join('server', 'masking', 'visibility.ts');
	const JOURNAL = join('server', 'journal', 'entries.ts');

	it('seuls le journal et la règle lisent la table des avis', () => {
		const coupables = fichiersSources(RACINE).filter((chemin) => {
			if (chemin.endsWith(MASQUAGE) || chemin.endsWith(JOURNAL)) return false;
			const source = readFileSync(chemin, 'utf8');
			// L’import de la table depuis le schéma, sous ses deux formes usuelles.
			return /import\s*\{[^}]*\breviews\b[^}]*\}\s*from\s*['"][^'"]*db\/schema['"]/.test(source);
		});

		expect(coupables).toEqual([]);
	});

	it('toute surface qui parle d’avis passe par la règle unique', () => {
		const surfaces = fichiersSources(join(RACINE, 'routes')).filter((chemin) =>
			/\+(page\.server|server)\.ts$/.test(chemin)
		);
		const coupables = surfaces.filter((chemin) => {
			const source = readFileSync(chemin, 'utf8');
			if (!/\bavis\b/i.test(source)) return false;
			return !/masking\/visibility/.test(source);
		});

		expect(coupables).toEqual([]);
	});
});

/** Une lecture directe, pour que la scène soit bien celle qu’on croit. */
describe('le harnais', () => {
	it('la base injectée est bien celle des routes', async () => {
		const { auteur } = await scene();
		const relu = await db.query.members.findFirst({ where: eq(members.id, auteur.id) });

		expect(relu?.displayName).toBe('Camille');
	});
});
