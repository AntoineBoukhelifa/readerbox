import { asc, isNull } from 'drizzle-orm';
import { members } from '../db/schema';
import type { Db } from '../db';

/**
 * L'entrée libre : l'adresse est la seule clé.
 *
 * Le produit s'ouvrait par invitation à usage unique, et se refermait sur
 * quiconque perdait sa session. Pour vingt amis qui se partagent une adresse,
 * cette cérémonie coûtait plus qu'elle ne protégeait : elle a enfermé dehors,
 * et jamais personne d'indésirable dedans.
 *
 * **Ce qui reste, et pourquoi.** L'identité, elle, ne disparaît pas. Le journal
 * est par membre, la progression d'un ordre est par membre, et surtout le
 * masquage anti-spoiler répond à la question « qu'est-ce que *tu* as atteint ».
 * Sans un nom derrière la session, il n'y aurait plus rien à masquer ni à
 * dévoiler. On supprime donc la preuve d'admission, pas la personne.
 *
 * **Ce qu'on accepte en échange.** Qui détient l'adresse peut reprendre
 * n'importe quel nom déjà présent. C'est délibéré — c'est précisément ce qui
 * remplace les liens de reconnexion : retrouver son journal sur un nouvel
 * appareil consiste à retaper son nom. Le groupe est fermé par le secret de
 * l'adresse, pas par une frontière entre ses membres.
 */

export const NOM_MIN = 2;
export const NOM_MAX = 40;

/** Espaces intérieurs réduits et bords coupés : « Jean  Luc » et « Jean Luc » sont un seul nom. */
export function normaliserLeNom(brut: string): string {
	return brut.trim().replace(/\s+/g, ' ');
}

/**
 * Deux noms désignent la même personne s'ils ne diffèrent que par la casse ou
 * les accents.
 *
 * C'est la comparaison qui décide si retaper son nom rend son journal ou en
 * ouvre un vide, donc elle doit pardonner ce qu'un clavier de téléphone fait
 * varier d'une fois sur l'autre — « antoine », « Antoine » et « Antoíne » sont
 * la même personne. La comparaison se fait en mémoire et non en SQL parce que
 * `LOWER()` de SQLite ignore les accents.
 */
export function memeNom(a: string, b: string): boolean {
	return normaliserLeNom(a).localeCompare(normaliserLeNom(b), 'fr', { sensitivity: 'base' }) === 0;
}

export type ResultatEntree =
	| { ok: true; membreId: string; nouveau: boolean }
	| { ok: false; motif: 'trop court' | 'trop long' };

/**
 * Entrer sous un nom : le crée s'il est neuf, le rend s'il est connu.
 *
 * Un seul champ fait les deux gestes, et c'est le but. « Se connecter » et
 * « s'inscrire » sont la même chose ici — demander à quelqu'un de choisir entre
 * les deux, c'est lui demander de se souvenir s'il est déjà venu.
 *
 * Un membre parti n'est pas repris : son nom retapé ouvre une personne neuve.
 * R38 lui a retiré sa place, et la lui rendre par une simple homonymie viderait
 * la règle de son sens.
 */
export async function entrer(
	db: Db,
	nomBrut: string,
	maintenant = Date.now()
): Promise<ResultatEntree> {
	const nom = normaliserLeNom(nomBrut);
	if (nom.length < NOM_MIN) return { ok: false, motif: 'trop court' };
	if (nom.length > NOM_MAX) return { ok: false, motif: 'trop long' };

	const presents = await db.query.members.findMany({ where: isNull(members.leftAt) });
	const connu = presents.find((membre) => memeNom(membre.displayName, nom));
	if (connu) return { ok: true, membreId: connu.id, nouveau: false };

	const [cree] = await db
		.insert(members)
		.values({ displayName: nom, createdAt: maintenant })
		.returning({ id: members.id });

	return { ok: true, membreId: cree.id, nouveau: true };
}

/**
 * Les noms déjà là, pour qu'on entre d'un geste plutôt qu'en tapant.
 *
 * La liste n'est pas une confidence : le fil d'activité et les avis nomment
 * déjà tout le monde. Elle épargne surtout la faute de frappe qui fabriquerait
 * un journal vide sous un nom presque juste.
 */
export async function nomsPresents(db: Db): Promise<{ id: string; nom: string }[]> {
	const presents = await db.query.members.findMany({
		where: isNull(members.leftAt),
		orderBy: asc(members.createdAt)
	});
	return presents.map((membre) => ({ id: membre.id, nom: membre.displayName }));
}
