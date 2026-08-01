import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import { members, works, type Member } from '../db/schema';
import { ingererOeuvre } from './ingest';
import type { AdaptateurDeSource, OeuvreDistante } from './sources/types';
import { T0, adaptateurFactice, entite, oeuvreDistante } from './testing';

/**
 * Les surfaces du catalogue, éprouvées sur ce qu'elles envoient et ce qu'elles
 * écrivent.
 *
 * Trois choses ne se voient qu'ici :
 *
 * - **une recherche n'écrit rien**, et une consignation écrit tout — c'est KTD1
 *   au point où il se constate, pas dans un module ;
 * - **une source en panne rend une page**, avec un message et les résultats qui
 *   restent, au lieu d'une erreur ;
 * - **un titre de source ne devient jamais du balisage**, parce qu'aucune surface
 *   n'utilise `{@html}`.
 *
 * Même harnais qu'en U6 et U7 : la base de test est injectée par substitution de
 * `getDb`, et les adaptateurs par substitution de `adaptateursDe`. Tout le reste
 * des routes s'exécute tel quel, sérialisation comprise — et **aucun appel ne
 * part vers une vraie API**.
 */
const contexte = vi.hoisted(() => ({
	db: null as unknown,
	adaptateurs: [] as AdaptateurDeSource[]
}));

vi.mock('$lib/server/db', async (importOriginal) => {
	const original = await importOriginal<typeof import('../db')>();
	return { ...original, getDb: () => contexte.db };
});

vi.mock('$lib/server/catalog/sources', async (importOriginal) => {
	const original = await importOriginal<typeof import('./sources')>();
	return { ...original, adaptateursDe: () => contexte.adaptateurs };
});

const { load: chargerRecherche, actions: actionsRecherche } =
	await import('../../../routes/search/+page.server');
const { load: chargerParcours } =
	await import('../../../routes/parcours/[axe]/[source]/[id]/+page.server');

let db: Db;

beforeEach(async () => {
	db = createTestDb();
	contexte.db = db;
	contexte.adaptateurs = [];
	// Le cache est un module de processus : sans purge, une recherche d'un test
	// servirait la réponse mémorisée par le précédent.
	const { cacheDeRecherche } = await import('./cache');
	cacheDeRecherche.oublier();
});

async function membre(nom = 'Camille'): Promise<Member> {
	const [ligne] = await db.insert(members).values({ displayName: nom, createdAt: T0 }).returning();
	return ligne;
}

/** Un événement de requête réduit à ce que les routes lisent. */
function evenement<T>(
	membreConnecte: Member | null,
	options: {
		params?: Record<string, string>;
		champs?: Record<string, string>;
		requete?: string;
	} = {}
): T {
	const corps = new FormData();
	for (const [nom, valeur] of Object.entries(options.champs ?? {})) corps.set(nom, valeur);

	return {
		params: options.params ?? {},
		url: new URL(`http://localhost/${options.requete ?? ''}`),
		locals: { member: membreConnecte },
		platform: { env: { DB: {} } },
		request: new Request('http://localhost/', { method: 'POST', body: corps })
	} as unknown as T;
}

function utile<T>(charge: T): Exclude<T, void> {
	return charge as Exclude<T, void>;
}

/**
 * Les colonnes qu'une surface de catalogue expose, telles que ces tests les
 * lisent. Le type déclaré des `load` de SvelteKit est volontairement large ;
 * l'écrire ici rend les assertions vérifiables au lieu de les laisser glisser
 * sur du `any`.
 */
interface ResultatEnvoye {
	titre: string;
	connueDuGroupe: boolean;
	consignee: boolean;
	oeuvreId: string | null;
}

const envoyes = (resultats: unknown): ResultatEnvoye[] => resultats as ResultatEnvoye[];

/** Ce qu'une action rend **ou** jette : `redirect` est une exception, pas un retour. */
async function issue(action: unknown): Promise<Record<string, unknown>> {
	try {
		return ((await (action as () => Promise<unknown>)()) ?? {}) as Record<string, unknown>;
	} catch (jetee) {
		return jetee as Record<string, unknown>;
	}
}

const numeroUn: OeuvreDistante = oeuvreDistante('metron', '44467', {
	titre: 'Immortal X-Men (2022) #1',
	numeroDansLaSerie: 1,
	dateDeParution: '2022-05-01',
	serie: entite('metron', '3231', 'Immortal X-Men'),
	couvertureUrl: 'https://static.metron.cloud/immortal-1.jpg',
	completude: { personnages: 'indisponibles', createurs: 'indisponibles', contenu: 'sans objet' }
});

const ficheUn: OeuvreDistante = oeuvreDistante('metron', '44467', {
	titre: 'Immortal X-Men #1',
	numeroDansLaSerie: 1,
	dateDeParution: '2022-05-01',
	serie: entite('metron', '3231', 'Immortal X-Men'),
	event: entite('metron', '1423', 'Destiny of X'),
	personnages: [entite('metron', '1391', 'Abigail Brand')],
	createurs: [{ ...entite('metron', '5', 'Kieron Gillen'), role: 'Writer' }]
});

describe('la page de recherche', () => {
	it('sert les résultats amont avec leurs couvertures, sans rien persister', async () => {
		contexte.adaptateurs = [adaptateurFactice({ resultats: [numeroUn] })];

		const charge = utile(
			await chargerRecherche(evenement(await membre(), { requete: '?q=Immortal+X-Men' }))
		);

		expect(charge.resultats).toHaveLength(1);
		expect(charge.resultats[0]).toMatchObject({
			titre: 'Immortal X-Men (2022) #1',
			couvertureUrl: 'https://static.metron.cloud/immortal-1.jpg',
			source: 'metron',
			idExterne: '44467',
			oeuvreId: null,
			connueDuGroupe: false
		});
		expect(await db.select().from(works)).toEqual([]);
	});

	it('une requête vide n’interroge personne et rend une page', async () => {
		const source = adaptateurFactice({ resultats: [numeroUn] });
		contexte.adaptateurs = [source];

		const charge = utile(await chargerRecherche(evenement(await membre())));

		expect(charge.resultats).toEqual([]);
		expect(source.appels).toEqual([]);
	});

	it('une source indisponible dégrade la page sans la faire échouer', async () => {
		await ingererOeuvre(db, oeuvreDistante('metron', 'local', { titre: 'Immortal X-Men #0' }), {
			now: T0
		});
		contexte.adaptateurs = [adaptateurFactice({ echec: 'indisponible' })];

		const charge = utile(
			await chargerRecherche(evenement(await membre(), { requete: '?q=Immortal+X-Men' }))
		);

		expect(charge.degradations).toHaveLength(1);
		expect(charge.degradations[0].message).toMatch(/ne répond pas/);
		expect(envoyes(charge.resultats).map((r) => r.titre)).toEqual(['Immortal X-Men #0']);
	});

	it('un quota est annoncé comme passager, jamais comme une panne', async () => {
		contexte.adaptateurs = [adaptateurFactice({ echec: 'quota' })];

		const charge = utile(
			await chargerRecherche(evenement(await membre(), { requete: '?q=Immortal' }))
		);

		expect(charge.degradations[0].motif).toBe('quota');
		expect(charge.degradations[0].message).toMatch(/reviendront dans un instant/);
	});

	it('refuse sans session', async () => {
		await expect(chargerRecherche(evenement(null, { requete: '?q=x' }))).rejects.toMatchObject({
			status: 401
		});
	});
});

describe('consigner depuis un résultat de recherche', () => {
	it('ingère l’œuvre avec ses personnages, sa série et son event, puis mène à sa fiche', async () => {
		const camille = await membre();
		contexte.adaptateurs = [adaptateurFactice({ fiches: { '44467': ficheUn } })];

		const resultat = await issue(() =>
			actionsRecherche.consigner(
				evenement(camille, {
					champs: { oeuvre: '', source: 'metron', idExterne: '44467', etagere: 'termine' }
				})
			)
		);

		expect(resultat.status).toBe(303);
		expect(String(resultat.location)).toMatch(/^\/work\//);

		const { lireOeuvre } = await import('./corrections');
		const oeuvreId = String(resultat.location).replace('/work/', '');
		const oeuvre = await lireOeuvre(db, oeuvreId);

		expect(oeuvre).toMatchObject({
			titre: 'Immortal X-Men #1',
			serie: { nom: 'Immortal X-Men' },
			event: { nom: 'Destiny of X' },
			etatIngestion: 'complete'
		});
		expect(oeuvre?.personnages.map((p) => p.nom)).toEqual(['Abigail Brand']);
	});

	it('une ingestion partielle consigne quand même, et le dit', async () => {
		const camille = await membre();
		contexte.adaptateurs = [
			adaptateurFactice({
				fiches: {
					'44467': {
						...ficheUn,
						personnages: [],
						completude: { ...ficheUn.completude, personnages: 'indisponibles' }
					}
				}
			})
		];

		const resultat = await issue(() =>
			actionsRecherche.consigner(
				evenement(camille, {
					champs: { oeuvre: '', source: 'metron', idExterne: '44467', etagere: 'termine' }
				})
			)
		);

		expect(resultat.message).toMatch(/complétera d’elle-même/);

		const [ligne] = await db.select().from(works);
		expect(ligne.ingestionState).toBe('partielle');
	});

	it('un quota refuse en 429 avec un message qui n’accuse personne, et n’écrit rien', async () => {
		const camille = await membre();
		contexte.adaptateurs = [adaptateurFactice({ echec: 'quota' })];

		const resultat = await issue(() =>
			actionsRecherche.consigner(
				evenement(camille, {
					champs: { oeuvre: '', source: 'metron', idExterne: '44467', etagere: 'termine' }
				})
			)
		);

		expect(resultat.status).toBe(429);
		expect(await db.select().from(works)).toEqual([]);
	});

	it('une œuvre déjà au catalogue se consigne sans toucher à la source', async () => {
		const camille = await membre();
		const { oeuvreId } = await ingererOeuvre(db, ficheUn, { now: T0 });
		const source = adaptateurFactice({ fiches: { '44467': ficheUn } });
		contexte.adaptateurs = [source];

		const resultat = await issue(() =>
			actionsRecherche.consigner(
				evenement(camille, { champs: { oeuvre: oeuvreId, etagere: 'en_cours' } })
			)
		);

		expect(resultat.location).toBe(`/work/${oeuvreId}`);
		expect(source.appels).toEqual([]);
	});

	it('refuse sans session, sans rien lire', async () => {
		const source = adaptateurFactice({ fiches: { '44467': ficheUn } });
		contexte.adaptateurs = [source];

		const resultat = await issue(() =>
			actionsRecherche.consigner(
				evenement(null, { champs: { source: 'metron', idExterne: '44467' } })
			)
		);

		expect(resultat.status).toBe(401);
		expect(source.appels).toEqual([]);
	});

	it('refuse une source forgée', async () => {
		const camille = await membre();
		contexte.adaptateurs = [adaptateurFactice({ fiches: { '44467': ficheUn } })];

		const resultat = await issue(() =>
			actionsRecherche.consigner(
				evenement(camille, { champs: { source: 'inconnue', idExterne: '44467' } })
			)
		);

		expect(resultat.status).toBe(400);
	});
});

describe('la page de parcours', () => {
	it('rend les apparitions amont d’un personnage, y compris non consignées', async () => {
		contexte.adaptateurs = [adaptateurFactice({ parcours: [numeroUn] })];

		const charge = utile(
			await chargerParcours(
				evenement(await membre(), {
					params: { axe: 'personnage', source: 'metron', id: '1391' }
				})
			)
		);

		expect(charge.axeCouvert).toBe(true);
		expect(envoyes(charge.resultats).map((r) => r.connueDuGroupe)).toEqual([false]);
		expect(charge.nom).toBeNull();
	});

	it('nomme la facette depuis le catalogue quand il la connaît', async () => {
		await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'x', {
				titre: 'Un numéro',
				personnages: [entite('metron', '1391', 'Abigail Brand')]
			}),
			{ now: T0 }
		);
		contexte.adaptateurs = [adaptateurFactice({ parcours: [] })];

		const charge = utile(
			await chargerParcours(
				evenement(await membre(), {
					params: { axe: 'personnage', source: 'metron', id: '1391' }
				})
			)
		);

		expect(charge.nom).toBe('Abigail Brand');
		expect(envoyes(charge.resultats).map((r) => r.titre)).toEqual(['Un numéro']);
	});

	it('un axe qu’aucune source ne couvre se distingue d’une panne', async () => {
		contexte.adaptateurs = [
			adaptateurFactice({ nom: 'tmdb', capacites: { parcoursParPersonnage: false } })
		];

		const charge = utile(
			await chargerParcours(
				evenement(await membre(), {
					params: { axe: 'personnage', source: 'tmdb', id: 'personne:3223' }
				})
			)
		);

		expect(charge.axeCouvert).toBe(false);
		expect(charge.degradations).toEqual([]);
	});

	it('refuse un axe inventé', async () => {
		await expect(
			chargerParcours(
				evenement(await membre(), { params: { axe: 'couleur', source: 'metron', id: '1' } })
			)
		).rejects.toMatchObject({ status: 404 });
	});
});

// ---------------------------------------------------------------------------
// Le garde-fou d'architecture
// ---------------------------------------------------------------------------

/**
 * Un titre de catalogue vient d'une source tierce et peut contenir n'importe
 * quoi. La règle du produit est qu'il s'affiche **comme texte littéral**, et la
 * seule façon de la tenir partout est de ne jamais employer `{@html}`.
 *
 * Un test de comportement ne l'attraperait pas : il porterait sur la page qu'on
 * a écrite, pas sur celle qu'on écrira. Celui-ci porte sur la forme.
 */
describe('aucune surface ne rend de balisage brut', () => {
	function fichiersSvelte(racine: string): string[] {
		return readdirSync(racine, { withFileTypes: true }).flatMap((entree) => {
			const chemin = join(racine, entree.name);
			if (entree.isDirectory()) return fichiersSvelte(chemin);
			return entree.name.endsWith('.svelte') ? [chemin] : [];
		});
	}

	it('aucun composant n’utilise {@html}', () => {
		const coupables = fichiersSvelte(join(process.cwd(), 'src')).filter((chemin) =>
			/\{@html\b/.test(readFileSync(chemin, 'utf8'))
		);

		expect(coupables).toEqual([]);
	});
});
