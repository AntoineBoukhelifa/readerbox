/**
 * La projection du graphe matérialisé en nœuds et arêtes affichables, et le
 * filtrage par dimension (R49, R50, AE11).
 *
 * **Ce module est pur et n'importe rien de `$lib/server`.** C'est ce qui permet
 * au filtrage de s'appliquer des deux côtés — dans le navigateur tant que le
 * volume le permet, sur le serveur au-delà — avec **la même fonction**. Deux
 * implémentations du même filtre finiraient par diverger, et le jour où elles
 * divergeraient l'une des deux montrerait une arête que l'autre cache.
 *
 * **Ce qui entre ici porte déjà la garantie de R52, et rien ici ne la rend.**
 * U9 a matérialisé à l'écriture précisément pour ça : une arête dont le lien
 * n'est établi que par une œuvre non atteinte n'a aucun appui, donc n'existe pas
 * dans ce qui arrive ici — y compris quand ses deux extrémités figurent déjà dans
 * le graphe par ailleurs. La projection ci-dessous **ne joint jamais deux nœuds
 * sans passer par un appui** : toute adjacence produite vient d'une œuvre que le
 * membre a atteinte et qui crédite les deux entités. Une projection qui partirait
 * des nœuds visibles pour les relier serait exactement le défaut que KTD4 existe
 * pour interdire.
 *
 * **Le nœud est l'entité, jamais l'œuvre** (R50). L'œuvre est portée par
 * l'appui : c'est elle qui relie deux entités, et elle n'apparaît pas comme
 * nœud. Un membre qui a lu trois cents numéros d'une série voit un nœud de
 * série, pas trois cent un nœuds.
 */

/** R49 — les trois types de relation, qui sont aussi les trois familles de nœuds. */
export const DIMENSIONS = ['personnage', 'serie', 'event'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const LIBELLES_DIMENSION: Record<Dimension, string> = {
	personnage: 'Personnages',
	serie: 'Séries',
	event: 'Events'
};

/**
 * Le plafond de R49 tel que le document d'origine l'entend : « multidimensionnel »
 * veut dire filtrable par dimension, **pas tout à la fois**.
 *
 * Après un an, un membre aura atteint des centaines d'œuvres ; les trois
 * dimensions affichées d'un bloc produisent la pelote illisible que R50 et ce
 * plafond existent tous les deux pour éviter. Deux dimensions suffisent à lire
 * une structure — « ce personnage traverse ces trois séries » — et la troisième
 * n'ajoute que du trait.
 */
export const MAX_DIMENSIONS_ACTIVES = 2;

/**
 * Ce qu'on montre à qui n'a rien demandé.
 *
 * Le personnage est la dimension qui surprend — c'est le nœud très connecté et
 * inattendu de F6 — et la série est celle qui donne l'ossature. L'event est le
 * plus rare des trois dans les données ingérées : en faire un défaut afficherait
 * souvent trois nœuds.
 */
export const DIMENSIONS_PAR_DEFAUT: readonly Dimension[] = ['personnage', 'serie'];

/**
 * Le point de bascule du filtrage, en arêtes projetées.
 *
 * En dessous, le serveur envoie le graphe entier et le navigateur filtre : cocher
 * une case ne coûte alors aucun aller-retour, ce qui est le geste que F6 répète.
 * Au-dessus, le serveur restreint les appuis aux dimensions actives **avant** de
 * projeter, et la surface repasse par lui à chaque changement.
 *
 * **Le seuil est mesuré, pas deviné** (`render.test.ts` le rejoue et l'affiche).
 * Sur le scénario de charge du plan — mille nœuds, cinq mille arêtes — la
 * projection coûte environ 6 ms et la charge utile 620 Ko, soit **127 octets par
 * arête**. C'est la charge utile qui borne, pas le calcul : à ce tarif, trois
 * mille arêtes pèsent environ 380 Ko, ce qui est déjà le plus gros de ce que le
 * produit envoie sur une page. Au-delà, on paierait à chaque ouverture des arêtes
 * que le membre ne regardera pas, pour économiser un aller-retour qu'il ne fera
 * peut-être pas.
 */
export const SEUIL_FILTRAGE_CLIENT = 3000;

/**
 * Le budget de la projection, en paires examinées.
 *
 * Le volume projeté **n'est pas borné par le nombre d'œuvres atteintes** : une
 * œuvre créditant vingt personnages produit à elle seule cent quatre-vingt-dix
 * adjacences, et trois cents œuvres atteintes en produisent plus de dix mille.
 * Mesuré à 1,2 µs la paire, ce budget-ci vaut une dizaine de millisecondes de
 * calcul : c'est ce que les 10 ms de temps processeur d'une requête laissent
 * (KTD2), et c'est pour ça qu'il est exprimé en travail plutôt qu'en résultat —
 * un plafond posé sur le nombre d'arêtes rendues ne borne rien, puisqu'il faut
 * déjà les avoir toutes calculées pour en couper.
 *
 * **Les œuvres les plus denses sont écartées les premières, et entières.** Une
 * œuvre à trente crédits produit quatre cent trente-cinq adjacences qui disent
 * toutes la même chose — « ces trente-là étaient dans le même numéro » — quand
 * une œuvre à trois crédits en produit trois, chacune précise. N'en projeter
 * qu'une partie donnerait un sous-ensemble arbitraire de ce qu'elle dit ; la
 * laisser de côté est une perte lisible, et `tronque` la signale, parce qu'un
 * graphe amputé en silence se lit comme un graphe complet.
 */
export const BUDGET_DE_PAIRES = 8000;

/**
 * Une ligne du graphe matérialisé, telle que U9 la rend.
 *
 * La forme est décrite structurellement plutôt qu'importée de
 * `server/graph/materialize.ts` : ce module part au navigateur, et rien de
 * `$lib/server` ne doit y entrer, pas même un type.
 */
export interface AppuiDEntite {
	relation: Dimension;
	entiteId: string;
	nom: string;
	/** Les œuvres atteintes qui établissent ce nœud (R51). Jamais vide. */
	appuis: readonly string[];
}

export interface NoeudDuGraphe {
	/** L'identité de l'entité. Une entité a un seul type, donc un seul nœud. */
	id: string;
	nom: string;
	dimension: Dimension;
	/** Combien d'œuvres atteintes l'ont établi (R51). Jamais zéro. */
	oeuvres: number;
}

/**
 * Une adjacence entre deux entités, portée par les œuvres atteintes qui les
 * créditent toutes les deux.
 *
 * `poids` est le nombre de ces œuvres. Il n'est pas décoratif : c'est lui qui
 * décide de ce qu'un graphe tronqué garde, et c'est ce que l'épaisseur du trait
 * rend visible — deux personnages croisés dans quinze numéros ne se lisent pas
 * comme deux personnages croisés une fois.
 */
export interface AreteRendue {
	/** Les deux extrémités, toujours triées : une adjacence n'a pas de sens. */
	source: string;
	cible: string;
	poids: number;
}

export interface GrapheRendu {
	noeuds: NoeudDuGraphe[];
	aretes: AreteRendue[];
	/**
	 * Le budget de projection a-t-il laissé des œuvres de côté ? Les nœuds sont
	 * tous là ; ce sont des adjacences qui manquent.
	 */
	tronque: boolean;
}

// ---------------------------------------------------------------------------
// Le choix des dimensions (R49)
// ---------------------------------------------------------------------------

export type RefusDeDimension = 'aucune dimension' | 'trop de dimensions';

export interface ChoixDeDimensions {
	/** Ce qui est effectivement appliqué — jamais vide, jamais plus de deux. */
	dimensions: Dimension[];
	/** Ce qui a été refusé, pour que la surface le dise au lieu de le taire. */
	refus: RefusDeDimension | null;
}

/**
 * Lit les dimensions demandées et applique le plafond de R49.
 *
 * **Une troisième dimension est refusée, pas rognée en silence.** L'interface
 * désactive déjà la troisième case, donc quiconque arrive ici avec trois valeurs
 * les a forgées dans l'URL : lui rendre deux dimensions sans rien dire lui
 * ferait croire que le plafond n'existe pas et que le graphe est incomplet.
 *
 * Un jeu vide est refusé de la même façon : c'est un état atteignable — décocher
 * les deux cases — dont le résultat, un écran sans rien, se confondrait avec
 * l'état d'accueil d'un membre qui n'a encore rien lu. Deux écrans identiques
 * pour deux situations opposées est le pire des rendus.
 */
export function analyserDimensions(brut: readonly string[]): ChoixDeDimensions {
	const demandees = DIMENSIONS.filter((dimension) => brut.includes(dimension));

	if (demandees.length === 0) {
		return {
			dimensions: [...DIMENSIONS_PAR_DEFAUT],
			refus: brut.length === 0 ? null : 'aucune dimension'
		};
	}

	if (demandees.length > MAX_DIMENSIONS_ACTIVES) {
		return { dimensions: demandees.slice(0, MAX_DIMENSIONS_ACTIVES), refus: 'trop de dimensions' };
	}

	return { dimensions: demandees, refus: null };
}

export function messageDeRefus(refus: RefusDeDimension): string {
	return refus === 'trop de dimensions'
		? `Deux dimensions à la fois, pas trois : au-delà, le graphe devient une pelote où plus rien ne se lit. Les ${MAX_DIMENSIONS_ACTIVES} premières sont affichées.`
		: 'Il faut au moins une dimension pour qu’il y ait quelque chose à voir.';
}

// ---------------------------------------------------------------------------
// La projection
// ---------------------------------------------------------------------------

/**
 * Le volume que le graphe complet représente, sans le projeter.
 *
 * `aretesEstimees` est la somme des paires par œuvre — un **majorant** du nombre
 * d'arêtes distinctes, puisque deux œuvres qui créditent le même couple ne font
 * qu'une arête. Il se calcule en un passage linéaire sur les appuis, là où
 * connaître le nombre exact demanderait de projeter : c'est ce qui permet de
 * décider où filtrer *avant* de payer la projection.
 */
export function mesurerVolume(appuis: readonly AppuiDEntite[]): {
	noeuds: number;
	appuis: number;
	aretesEstimees: number;
} {
	const parOeuvre = entitesParOeuvre(appuis);

	let aretesEstimees = 0;
	let lignes = 0;
	for (const entites of parOeuvre.values()) {
		aretesEstimees += (entites.length * (entites.length - 1)) / 2;
		lignes += entites.length;
	}

	return { noeuds: appuis.length, appuis: lignes, aretesEstimees };
}

/**
 * Projette les appuis en un graphe d'entités.
 *
 * Deux entités sont adjacentes **si et seulement si une œuvre atteinte les
 * crédite toutes les deux**. C'est la « double appartenance au même nœud
 * d'œuvre » de KTD4, qui dispense d'avoir matérialisé les co-apparitions deux à
 * deux : la cardinalité reste linéaire en base — un numéro à vingt personnages y
 * coûte vingt lignes — et la forme quadratique n'est payée qu'ici, en mémoire,
 * pour le seul membre qui regarde.
 *
 * L'ordre du résultat est déterministe : deux graphes se comparent, et un
 * affichage stable ne redessine pas tout à chaque rechargement.
 */
export function projeter(appuis: readonly AppuiDEntite[]): GrapheRendu {
	const noeuds: NoeudDuGraphe[] = [];
	const vus = new Set<string>();
	for (const appui of appuis) {
		// Une entité a un seul type, donc un seul nœud. La garde n'est pas
		// superflue : deux lignes sur la même entité produiraient deux nœuds de
		// même identité, et Cytoscape refuse le graphe entier pour ça.
		if (vus.has(appui.entiteId)) continue;
		vus.add(appui.entiteId);
		noeuds.push({
			id: appui.entiteId,
			nom: appui.nom,
			dimension: appui.relation,
			oeuvres: appui.appuis.length
		});
	}
	noeuds.sort(
		(a, b) =>
			a.dimension.localeCompare(b.dimension) ||
			a.nom.localeCompare(b.nom) ||
			a.id.localeCompare(b.id)
	);

	/**
	 * Les paires sont comptées sur des **indices**, pas sur des identifiants : la
	 * clé tient alors dans un entier au lieu de concaténer deux UUID des dizaines
	 * de milliers de fois. C'est la boucle chaude de tout U10 — quadratique dans
	 * le nombre d'entités créditées par œuvre — et la mesure du scénario de charge
	 * lui donne un sixième de gain.
	 *
	 * Le reste du chemin, lui, avait un coût inattendu et bien plus gros : trier
	 * cinq mille arêtes avec `localeCompare` pesait dix millisecondes à soi seul,
	 * soit davantage que la projection. Voir le tri plus bas.
	 */
	const rang = new Map(noeuds.map((noeud, index) => [noeud.id, index]));
	const largeur = noeuds.length;
	const compte = new Map<number, number>();

	// Les œuvres les moins denses d'abord : quand le budget s'épuise, ce sont les
	// plus denses — celles dont chaque paire apprend le moins — qui restent
	// dehors. Le tri croissant rend l'arrêt franc : dès qu'une œuvre ne tient
	// plus, aucune des suivantes ne tiendra.
	const groupes = [...entitesParOeuvre(appuis).values()].sort((a, b) => a.length - b.length);

	let budget = BUDGET_DE_PAIRES;
	let tronque = false;

	for (const entites of groupes) {
		const paires = (entites.length * (entites.length - 1)) / 2;
		if (paires > budget) {
			tronque = true;
			break;
		}
		budget -= paires;

		const indices = entites
			.map((entiteId) => rang.get(entiteId))
			.filter((index): index is number => index !== undefined)
			.sort((a, b) => a - b);

		for (let i = 0; i < indices.length; i += 1) {
			for (let j = i + 1; j < indices.length; j += 1) {
				const cle = indices[i] * largeur + indices[j];
				compte.set(cle, (compte.get(cle) ?? 0) + 1);
			}
		}
	}

	const aretes: AreteRendue[] = [];
	for (const [cle, valeur] of compte) {
		aretes.push({
			source: noeuds[Math.floor(cle / largeur)].id,
			cible: noeuds[cle % largeur].id,
			poids: valeur
		});
	}
	// Les arêtes se trient sur des identifiants, pas sur du texte lisible : la
	// comparaison brute suffit à rendre l'ordre déterministe, et `localeCompare`
	// — qui passe par la collation Intl — coûtait ici plus cher que la projection
	// elle-même. Les nœuds, eux, se trient sur des noms français et la gardent.
	aretes.sort(
		(a, b) => b.poids - a.poids || comparer(a.source, b.source) || comparer(a.cible, b.cible)
	);

	return { noeuds, aretes, tronque };
}

/** L'ordre lexicographique brut, pour ce qui n'est pas destiné à être lu. */
function comparer(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Les entités que chaque œuvre atteinte crédite, triées pour que les paires soient stables. */
function entitesParOeuvre(appuis: readonly AppuiDEntite[]): Map<string, string[]> {
	const parOeuvre = new Map<string, string[]>();
	for (const appui of appuis) {
		for (const oeuvre of appui.appuis) {
			const liste = parOeuvre.get(oeuvre);
			if (liste) liste.push(appui.entiteId);
			else parOeuvre.set(oeuvre, [appui.entiteId]);
		}
	}
	for (const entites of parOeuvre.values()) entites.sort();
	return parOeuvre;
}

/**
 * AE11 — ne garder que les dimensions actives.
 *
 * **Le filtre porte sur les nœuds, et les arêtes suivent.** Une adjacence relie
 * deux entités ; elle n'a de type que celui de ses extrémités, et n'a donc de
 * sens que si les deux sont affichées. Activer la seule dimension personnage
 * laisse ainsi exactement les arêtes personnage-personnage, ce qui est la lettre
 * de AE11 ; y ajouter la série fait apparaître, en plus, les liens qui vont d'un
 * personnage à une série.
 *
 * **Idempotent** : appliquer ce filtre à un graphe déjà filtré ne change rien.
 * C'est ce qui permet à la surface de l'appliquer systématiquement, que le
 * serveur ait pré-filtré ou non, sans avoir à savoir lequel des deux a travaillé.
 */
export function filtrer(graphe: GrapheRendu, dimensions: readonly Dimension[]): GrapheRendu {
	const actives = new Set(dimensions);
	const noeuds = graphe.noeuds.filter((noeud) => actives.has(noeud.dimension));
	const gardes = new Set(noeuds.map((noeud) => noeud.id));

	return {
		noeuds,
		aretes: graphe.aretes.filter((arete) => gardes.has(arete.source) && gardes.has(arete.cible)),
		tronque: graphe.tronque
	};
}

/** Les appuis restreints aux dimensions actives, avant projection. */
export function restreindre(
	appuis: readonly AppuiDEntite[],
	dimensions: readonly Dimension[]
): AppuiDEntite[] {
	const actives = new Set(dimensions);
	return appuis.filter((appui) => actives.has(appui.relation));
}
