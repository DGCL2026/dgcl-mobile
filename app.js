/* ==========================================================================
   DGCL Connect — version mobile (consultation seule)

   Fonctionnement : l'application lit le fichier de configuration
   dgcl-permissions.json déposé sur le Drive de la Direction par
   l'application de bureau, en déduit les droits de l'agent connecté, et
   n'affiche que les dossiers qui lui sont ouverts.

   Aucune écriture n'est effectuée sur Google Drive : la portée demandée est
   strictement « lecture seule ».
   ========================================================================== */

(function () {
  "use strict";

  var CFG = window.CONFIG_DGCL || {};
  var API = "https://www.googleapis.com/drive/v3";
  var PORTEE = "https://www.googleapis.com/auth/drive.readonly email profile";

  // ----------------------------------------------------------------- état

  var etat = {
    jeton: null,
    expireA: 0,
    email: null,
    config: null,
    agent: null,
    role: null,
    dossiers: [],
    vue: "dossiers",
    dossierCourant: null,
    clientJeton: null,
    minuteurVerrou: null,
    sourceConfig: "",
  };

  // ------------------------------------------------------------- raccourcis

  function $(id) { return document.getElementById(id); }

  function montrer(element, visible) {
    if (element) element.hidden = !visible;
  }

  function vider(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function creer(balise, classe, texte) {
    var el = document.createElement(balise);
    if (classe) el.className = classe;
    if (texte !== undefined && texte !== null) el.textContent = texte;
    return el;
  }

  var minuteurNotif = null;
  function notifier(texte) {
    var n = $("notification");
    n.textContent = texte;
    montrer(n, true);
    clearTimeout(minuteurNotif);
    minuteurNotif = setTimeout(function () { montrer(n, false); }, 3200);
  }

  // --------------------------------------------------------------- formats

  function formaterDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var aujourdhui = new Date();
    var memeJour = d.toDateString() === aujourdhui.toDateString();
    if (memeJour) {
      return "Aujourd'hui " + d.toLocaleTimeString("fr-FR",
        { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString("fr-FR",
      { day: "numeric", month: "short", year: "numeric" });
  }

  function formaterTaille(octets) {
    var n = Number(octets);
    if (!n || isNaN(n)) return "";
    if (n < 1024) return n + " o";
    if (n < 1048576) return Math.round(n / 1024) + " Ko";
    return (n / 1048576).toFixed(1).replace(".", ",") + " Mo";
  }

  // Étiquette courte affichée dans la pastille, déduite du type de fichier.
  function etiquetteType(nom, mime) {
    var ext = (nom || "").split(".").pop().toLowerCase();
    var connus = {
      pdf: "PDF", doc: "DOC", docx: "DOC", odt: "ODT",
      xls: "XLS", xlsx: "XLS", csv: "CSV", ods: "ODS",
      ppt: "PPT", pptx: "PPT",
      jpg: "IMG", jpeg: "IMG", png: "IMG", gif: "IMG", webp: "IMG", heic: "IMG",
      txt: "TXT", zip: "ZIP", rar: "ZIP",
    };
    if (connus[ext]) return connus[ext];
    if (mime) {
      if (mime.indexOf("image/") === 0) return "IMG";
      if (mime.indexOf("pdf") !== -1) return "PDF";
      if (mime.indexOf("spreadsheet") !== -1) return "XLS";
      if (mime.indexOf("presentation") !== -1) return "PPT";
      if (mime.indexOf("document") !== -1) return "DOC";
    }
    return "FIC";
  }

  // Sépare « Archives DGCL/Année 2026/Minutes » en exercice + intitulé.
  function decouperChemin(chemin) {
    var parties = String(chemin || "").split("/").filter(Boolean);
    var exercice = "";
    var intitule = parties[parties.length - 1] || chemin || "Dossier";
    for (var i = 0; i < parties.length; i++) {
      var m = parties[i].match(/(\d{4})/);
      if (m) exercice = m[1];
    }
    return { exercice: exercice, intitule: intitule };
  }

  // ------------------------------------------------------------ permissions

  function actionsDuRole(role) {
    if (!role) return [];
    if (Array.isArray(role.actions)) return role.actions;
    if (Array.isArray(role.permissions)) return role.permissions;
    return [];
  }

  function trouverAgent(config, email) {
    var cible = String(email || "").trim().toLowerCase();
    var liste = (config && config.agents) || [];
    for (var i = 0; i < liste.length; i++) {
      if (String(liste[i].email || "").trim().toLowerCase() === cible) return liste[i];
    }
    return null;
  }

  // Un dossier est écarté de la version mobile s'il est confidentiel, quelle
  // que soit l'habilitation de l'agent. Cette règle n'est pas contournable
  // depuis l'interface.
  function dossierExclusDuMobile(dossier) {
    var exclues = CFG.CATEGORIES_EXCLUES || [];
    var categorie = String(dossier.category || "").toLowerCase();
    for (var i = 0; i < exclues.length; i++) {
      if (categorie === String(exclues[i]).toLowerCase()) return true;
    }
    if (categorie.indexOf("confidentiel") !== -1) return true;
    var seuil = CFG.NIVEAU_EXCLU_A_PARTIR_DE || 4;
    if (Number(dossier.minLevel) >= seuil) return true;
    return false;
  }

  function calculerDossiers(config, email) {
    var agent = trouverAgent(config, email);
    if (!agent) return [];
    var role = (config.roles || {})[agent.role];
    if (!role) return [];
    var actions = actionsDuRole(role);
    if (actions.indexOf("view") === -1) return [];
    var niveau = Number(role.level) || 0;

    return (config.folders || [])
      .filter(function (d) {
        if (dossierExclusDuMobile(d)) return false;
        return niveau >= (Number(d.minLevel) || 1);
      })
      .map(function (d) {
        var c = decouperChemin(d.path);
        return {
          id: d.driveFolderId,
          chemin: d.path,
          exercice: c.exercice,
          intitule: c.intitule,
          categorie: d.category || "",
        };
      });
  }

  // -------------------------------------------------------------- connexion

  function jetonValide() {
    return etat.jeton && Date.now() < etat.expireA - 60000;
  }

  function initialiserClientJeton() {
    if (etat.clientJeton) return true;
    if (!window.google || !google.accounts || !google.accounts.oauth2) return false;

    etat.clientJeton = google.accounts.oauth2.initTokenClient({
      client_id: CFG.CLIENT_ID,
      scope: PORTEE,
      callback: function (reponse) {
        if (reponse && reponse.access_token) {
          etat.jeton = reponse.access_token;
          etat.expireA = Date.now() + (Number(reponse.expires_in) || 3600) * 1000;
          try {
            sessionStorage.setItem("dgcl_jeton", etat.jeton);
            sessionStorage.setItem("dgcl_expire", String(etat.expireA));
          } catch (e) { /* navigation privée : sans conséquence */ }
          demarrerSession();
        } else {
          afficherErreurConnexion("La connexion n'a pas abouti. Réessayez.");
        }
      },
      error_callback: function (err) {
        var motif = err && err.type === "popup_closed"
          ? "Fenêtre de connexion fermée avant la fin."
          : "La connexion a échoué. Vérifiez votre réseau et réessayez.";
        afficherErreurConnexion(motif);
      },
    });
    return true;
  }

  function demanderConnexion(silencieux) {
    if (!initialiserClientJeton()) {
      afficherErreurConnexion(
        "Le service de connexion Google n'a pas pu être chargé. Vérifiez votre connexion internet.");
      return;
    }
    etat.clientJeton.requestAccessToken({ prompt: silencieux ? "" : "consent" });
  }

  function afficherErreurConnexion(texte) {
    montrer($("ecran-chargement"), false);
    montrer($("ecran-connexion"), true);
    var p = $("connexion-message");
    p.textContent = texte;
    p.className = "message message--erreur";
    montrer(p, true);
    $("btn-connexion").disabled = false;
  }

  function deconnecter(motif) {
    if (etat.jeton && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(etat.jeton); } catch (e) {}
    }
    etat.jeton = null;
    etat.expireA = 0;
    etat.email = null;
    etat.config = null;
    etat.agent = null;
    etat.dossiers = [];
    try {
      sessionStorage.removeItem("dgcl_jeton");
      sessionStorage.removeItem("dgcl_expire");
    } catch (e) {}
    clearTimeout(etat.minuteurVerrou);

    montrer($("application"), false);
    montrer($("ecran-chargement"), false);
    montrer($("ecran-connexion"), true);
    $("btn-connexion").disabled = false;

    var p = $("connexion-message");
    if (motif) {
      p.textContent = motif;
      p.className = "message";
      montrer(p, true);
    } else {
      montrer(p, false);
    }
  }

  // Verrouillage après inactivité : un téléphone posé sur une table ne doit
  // pas rester ouvert sur le registre.
  function reporterVerrouillage() {
    clearTimeout(etat.minuteurVerrou);
    var minutes = Number(CFG.MINUTES_AVANT_VERROUILLAGE) || 10;
    etat.minuteurVerrou = setTimeout(function () {
      deconnecter("Session fermée après " + minutes + " minutes sans activité.");
    }, minutes * 60000);
  }

  // ------------------------------------------------------- appels à l'API

  function appelDrive(chemin) {
    if (!jetonValide()) {
      return Promise.reject(new Error("SESSION_EXPIREE"));
    }
    return fetch(API + chemin, {
      headers: { Authorization: "Bearer " + etat.jeton },
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) {
        throw new Error("SESSION_EXPIREE");
      }
      if (!r.ok) throw new Error("Drive a répondu " + r.status);
      return r.json();
    });
  }

  function lireFichierJson(fileId) {
    return fetch(API + "/files/" + fileId + "?alt=media&supportsAllDrives=true", {
      headers: { Authorization: "Bearer " + etat.jeton },
    }).then(function (r) {
      if (!r.ok) throw new Error("Lecture impossible (" + r.status + ")");
      return r.text();
    }).then(function (t) {
      var v = JSON.parse(t || "[]");
      return v;
    });
  }

  function recupererEmail() {
    return fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + etat.jeton },
    }).then(function (r) {
      if (!r.ok) throw new Error("SESSION_EXPIREE");
      return r.json();
    }).then(function (info) { return info.email; });
  }

  // Le fichier de configuration est lu en priorité à l'identifiant indiqué
  // dans config.js. À défaut, il est recherché par son nom sur le Drive de
  // l'agent — mais cette recherche peut tomber sur une sauvegarde ancienne,
  // d'où la préférence donnée à l'identifiant explicite.
  function chargerConfiguration() {
    if (CFG.FICHIER_CONFIG) {
      return lireFichierJson(CFG.FICHIER_CONFIG).then(function (v) {
        if (v && v.roles && v.folders) {
          etat.sourceConfig = "fichier désigné";
          return v;
        }
        return rechercherConfiguration();
      }).catch(function () { return rechercherConfiguration(); });
    }
    return rechercherConfiguration();
  }

  function rechercherConfiguration() {
    var q = encodeURIComponent(
      "name contains 'dgcl-' and mimeType = 'application/json' and trashed = false");
    return appelDrive("/files?q=" + q +
        "&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=25" +
        "&supportsAllDrives=true&includeItemsFromAllDrives=true")
      .then(function (r) {
        var tous = r.files || [];
        // Les sauvegardes sont écartées : elles peuvent être très anciennes.
        var candidats = tous.filter(function (f) {
          return /permission/i.test(f.name) && !/backup|sauvegarde|copie/i.test(f.name);
        });
        if (candidats.length === 0) {
          candidats = tous.filter(function (f) { return /permission|config/i.test(f.name); });
        }
        if (candidats.length === 0) candidats = tous;
        if (candidats.length === 0) throw new Error("CONFIG_ABSENTE");

        // À contenu valide égal, on retient celui qui décrit le plus de
        // dossiers : c'est nécessairement le plus complet.
        var suivant = function (i, meilleur, nom) {
          if (i >= candidats.length) {
            if (!meilleur) throw new Error("CONFIG_ABSENTE");
            etat.sourceConfig = nom;
            return meilleur;
          }
          return lireFichierJson(candidats[i].id).then(function (v) {
            if (v && v.roles && v.folders) {
              var mieux = !meilleur || (v.folders.length > meilleur.folders.length);
              return suivant(i + 1, mieux ? v : meilleur,
                             mieux ? candidats[i].name : nom);
            }
            return suivant(i + 1, meilleur, nom);
          }).catch(function () { return suivant(i + 1, meilleur, nom); });
        };
        return suivant(0, null, "");
      });
  }

  function listerFichiers(dossierId) {
    var q = encodeURIComponent("'" + dossierId + "' in parents and trashed = false");
    var taille = Number(CFG.DOCUMENTS_PAR_PAGE) || 60;
    return appelDrive("/files?q=" + q +
      "&fields=files(id,name,mimeType,size,modifiedTime)" +
      "&orderBy=modifiedTime desc&pageSize=" + taille +
      "&supportsAllDrives=true&includeItemsFromAllDrives=true");
  }

  function rechercher(terme) {
    var ids = etat.dossiers.map(function (d) { return "'" + d.id + "' in parents"; });
    if (ids.length === 0) return Promise.resolve({ files: [] });
    var propre = terme.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    var q = "(" + ids.join(" or ") + ") and trashed = false and " +
            "(name contains '" + propre + "' or fullText contains '" + propre + "')";
    return appelDrive("/files?q=" + encodeURIComponent(q) +
      "&fields=files(id,name,mimeType,size,modifiedTime,parents)" +
      "&orderBy=modifiedTime desc&pageSize=40" +
      "&supportsAllDrives=true&includeItemsFromAllDrives=true");
  }

  // ---------------------------------------------------------- démarrage

  function demarrerSession() {
    montrer($("ecran-connexion"), false);
    montrer($("ecran-chargement"), true);
    $("chargement-texte").textContent = "Vérification de votre habilitation…";

    recupererEmail()
      .then(function (email) {
        etat.email = email;
        $("chargement-texte").textContent = "Ouverture du registre…";
        return chargerConfiguration();
      })
      .then(function (config) {
        etat.config = config;
        etat.agent = trouverAgent(config, etat.email);

        if (!etat.agent) {
          deconnecter("Le compte " + etat.email + " ne figure pas parmi les agents " +
            "habilités. Adressez-vous à la Direction Générale.");
          return;
        }

        etat.role = (config.roles || {})[etat.agent.role] || null;
        etat.dossiers = calculerDossiers(config, etat.email);

        montrer($("ecran-chargement"), false);
        montrer($("application"), true);
        preparerCompte();
        afficherDossiers();
        chargerDerniereAnnonce();
        reporterVerrouillage();
      })
      .catch(function (err) {
        if (err && err.message === "SESSION_EXPIREE") {
          deconnecter("Votre session a expiré. Reconnectez-vous.");
        } else if (err && err.message === "CONFIG_ABSENTE") {
          deconnecter("Le registre n'est pas accessible depuis ce compte. " +
            "Vérifiez auprès de la Direction que le dossier partagé vous est ouvert.");
        } else {
          deconnecter("Le registre n'a pas pu être ouvert. Vérifiez votre connexion.");
        }
      });
  }

  function preparerCompte() {
    var nom = etat.agent.name || etat.email;
    var initiales = nom.trim().split(/\s+/).slice(0, 2)
      .map(function (m) { return m.charAt(0).toUpperCase(); }).join("");
    $("initiales").textContent = initiales || "?";
    $("compte-nom").textContent = nom;
    $("compte-email").textContent = etat.email;
    $("compte-role").textContent = (etat.role && etat.role.label) || etat.agent.role;
    $("compte-dossiers").textContent = etat.dossiers.length;
    // Diagnostic : permet de vérifier que la configuration lue est bien la
    // configuration courante, et non une sauvegarde partielle.
    var total = (etat.config.folders || []).length;
    var exclus = (etat.config.folders || []).filter(dossierExclusDuMobile).length;
    $("compte-total").textContent =
      total + " au total, dont " + exclus + " confidentiel" + (exclus > 1 ? "s" : "");
    $("compte-source").textContent = etat.sourceConfig || "recherche automatique";
  }

  // ------------------------------------------------------------- annonce

  function chargerDerniereAnnonce() {
    var id = etat.config.announcementsFileId;
    if (!id) return;
    lireFichierJson(id).then(function (liste) {
      if (!Array.isArray(liste) || liste.length === 0) return;
      var a = liste[liste.length - 1];
      $("annonce-titre").textContent = a.title || "";
      $("annonce-texte").textContent = a.content || "";
      $("annonce-meta").textContent =
        (a.name || "") + " — " + formaterDate(a.date);
      montrer($("bandeau-annonce"), true);
    }).catch(function () { /* l'absence d'annonce n'est pas une erreur */ });
  }

  // ---------------------------------------------------------------- vues

  function basculerVue(nom, titre, soustitre) {
    ["dossiers", "fichiers", "recherche", "apercu", "compte"].forEach(function (v) {
      montrer($("vue-" + v), v === nom);
    });
    etat.vue = nom;
    $("entete-titre").textContent = titre;
    $("entete-soustitre").textContent = soustitre || "";
    // Le logo tient la place du bouton retour sur l'écran d'accueil : les deux
    // ne sont jamais affichés en même temps, pour ne pas surcharger l'en-tête.
    montrer($("btn-retour"), nom !== "dossiers");
    montrer($("entete-logo"), nom === "dossiers");
    if (nom !== "apercu") $("cadre-apercu").src = "about:blank";
    window.scrollTo(0, 0);
  }

  function fleche() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("class", "rangee__fleche");
    svg.setAttribute("aria-hidden", "true");
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "m9 5 7 7-7 7");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
    return svg;
  }

  function construireRangee(etiquette, nom, meta, action) {
    var b = creer("button", "rangee");
    b.type = "button";
    // La pastille n'est affichée que lorsqu'elle distingue réellement les
    // lignes entre elles, c'est-à-dire pour les types de documents. Sur une
    // liste de dossiers, elle serait identique partout.
    if (etiquette) b.appendChild(creer("span", "rangee__icone", etiquette));
    var corps = creer("div", "rangee__corps");
    corps.appendChild(creer("p", "rangee__nom", nom));
    if (meta) corps.appendChild(creer("p", "rangee__meta", meta));
    b.appendChild(corps);
    b.appendChild(fleche());
    b.addEventListener("click", action);
    return b;
  }

  function messageVide(titre, texte) {
    var d = creer("div", "vide");
    d.appendChild(creer("p", "vide__titre", titre));
    d.appendChild(creer("p", null, texte));
    return d;
  }

  // ------------------------------------------------------ liste dossiers

  function afficherDossiers() {
    var conteneur = $("liste-dossiers");
    vider(conteneur);
    basculerVue("dossiers", "Registre",
      etat.dossiers.length + (etat.dossiers.length > 1 ? " dossiers" : " dossier"));

    if (etat.dossiers.length === 0) {
      conteneur.appendChild(messageVide(
        "Aucun dossier accessible",
        "Votre habilitation ne donne accès à aucun dossier depuis un téléphone. " +
        "Les dossiers confidentiels restent réservés aux postes de travail."));
      return;
    }

    // Regroupement par exercice, du plus récent au plus ancien.
    var SANS = "\uFFFF"; // trié en dernier
    var groupes = {};
    etat.dossiers.forEach(function (d) {
      var cle = d.exercice || SANS;
      (groupes[cle] = groupes[cle] || []).push(d);
    });

    Object.keys(groupes).sort(function (a, b) { return b.localeCompare(a); })
      .forEach(function (cle) {
        var bloc = creer("section", "exercice");
        bloc.appendChild(creer("h2", "exercice__titre",
          cle === SANS ? "Hors exercice" : "Exercice " + cle));
        var rangees = creer("div", "rangees");
        groupes[cle].forEach(function (d) {
          // Le chemin complet répéterait le nom et l'exercice déjà affichés.
          rangees.appendChild(construireRangee(
            null, d.intitule, null,
            function () { ouvrirDossier(d); }));
        });
        bloc.appendChild(rangees);
        conteneur.appendChild(bloc);
      });
  }

  // ------------------------------------------------------ contenu dossier

  function ouvrirDossier(dossier) {
    etat.dossierCourant = dossier;
    var conteneur = $("liste-fichiers");
    vider(conteneur);
    basculerVue("fichiers", dossier.intitule,
      dossier.exercice ? "Exercice " + dossier.exercice : dossier.chemin);
    conteneur.appendChild(messageVide("Chargement…", "Lecture du dossier en cours."));

    listerFichiers(dossier.id).then(function (r) {
      vider(conteneur);
      var fichiers = (r.files || []).filter(function (f) {
        // Les fichiers techniques de l'application ne concernent pas l'agent.
        return !/^dgcl-/i.test(f.name) &&
               f.mimeType !== "application/vnd.google-apps.folder";
      });

      if (fichiers.length === 0) {
        conteneur.appendChild(messageVide("Dossier vide",
          "Aucun document n'a encore été déposé dans ce dossier."));
        return;
      }

      var rangees = creer("div", "rangees");
      fichiers.forEach(function (f) {
        var meta = [formaterDate(f.modifiedTime), formaterTaille(f.size)]
          .filter(Boolean).join(" · ");
        rangees.appendChild(construireRangee(
          etiquetteType(f.name, f.mimeType), f.name, meta,
          function () { ouvrirApercu(f); }));
      });
      conteneur.appendChild(rangees);
    }).catch(function (err) {
      vider(conteneur);
      if (err && err.message === "SESSION_EXPIREE") {
        deconnecter("Votre session a expiré. Reconnectez-vous.");
        return;
      }
      conteneur.appendChild(messageVide("Dossier indisponible",
        "Le contenu n'a pas pu être chargé. Vérifiez votre connexion et réessayez."));
    });
  }

  // ------------------------------------------------------------- recherche

  var minuteurRecherche = null;

  function lancerRecherche(terme) {
    var conteneur = $("liste-resultats");
    vider(conteneur);
    basculerVue("recherche", "Recherche", terme);
    conteneur.appendChild(messageVide("Recherche en cours…",
      "Consultation des dossiers qui vous sont ouverts."));

    rechercher(terme).then(function (r) {
      vider(conteneur);
      var fichiers = (r.files || []).filter(function (f) {
        return !/^dgcl-/i.test(f.name);
      });

      if (fichiers.length === 0) {
        conteneur.appendChild(messageVide("Aucun résultat",
          "Aucun document ne correspond à « " + terme + " » dans les dossiers " +
          "qui vous sont ouverts."));
        return;
      }

      basculerVue("recherche", "Recherche",
        fichiers.length + (fichiers.length > 1 ? " résultats" : " résultat"));

      var rangees = creer("div", "rangees");
      fichiers.forEach(function (f) {
        var dossier = null;
        if (f.parents && f.parents.length) {
          dossier = etat.dossiers.filter(function (d) {
            return f.parents.indexOf(d.id) !== -1;
          })[0];
        }
        var meta = [dossier ? dossier.intitule : "", formaterDate(f.modifiedTime)]
          .filter(Boolean).join(" · ");
        rangees.appendChild(construireRangee(
          etiquetteType(f.name, f.mimeType), f.name, meta,
          function () { ouvrirApercu(f); }));
      });
      conteneur.appendChild(rangees);
    }).catch(function (err) {
      vider(conteneur);
      if (err && err.message === "SESSION_EXPIREE") {
        deconnecter("Votre session a expiré. Reconnectez-vous.");
        return;
      }
      conteneur.appendChild(messageVide("Recherche impossible",
        "La recherche n'a pas abouti. Vérifiez votre connexion et réessayez."));
    });
  }

  // --------------------------------------------------------------- aperçu

  function ouvrirApercu(fichier) {
    basculerVue("apercu", fichier.name, formaterDate(fichier.modifiedTime));
    $("cadre-apercu").src =
      "https://drive.google.com/file/d/" + fichier.id + "/preview";
    // Drive affiche les documents Word et Excel bien mieux que le cadre
    // intégré, et gère le défilement page à page sur téléphone.
    $("lien-drive").href = "https://drive.google.com/file/d/" + fichier.id + "/view";
    $("lien-telecharger").href =
      "https://drive.google.com/uc?export=download&id=" + fichier.id;
  }

  // -------------------------------------------------------------- navigation

  function revenir() {
    if (etat.vue === "apercu") {
      if (etat.dossierCourant && $("champ-recherche").value.trim() === "") {
        ouvrirDossier(etat.dossierCourant);
      } else if ($("champ-recherche").value.trim() !== "") {
        lancerRecherche($("champ-recherche").value.trim());
      } else {
        afficherDossiers();
      }
      return;
    }
    $("champ-recherche").value = "";
    afficherDossiers();
  }

  // ------------------------------------------------------------ événements

  function brancherEvenements() {
    $("btn-connexion").addEventListener("click", function () {
      this.disabled = true;
      montrer($("connexion-message"), false);
      demanderConnexion(false);
    });

    $("btn-retour").addEventListener("click", revenir);

    $("btn-compte").addEventListener("click", function () {
      if (etat.vue === "compte") { revenir(); return; }
      basculerVue("compte", "Votre compte", etat.agent ? etat.agent.name : "");
    });

    $("btn-deconnexion").addEventListener("click", function () {
      deconnecter("Vous êtes déconnecté.");
    });

    var champ = $("champ-recherche");
    champ.addEventListener("input", function () {
      clearTimeout(minuteurRecherche);
      var terme = champ.value.trim();
      if (terme.length < 3) {
        if (etat.vue === "recherche") afficherDossiers();
        return;
      }
      minuteurRecherche = setTimeout(function () { lancerRecherche(terme); }, 450);
    });

    champ.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        champ.blur();
        var terme = champ.value.trim();
        if (terme.length >= 2) {
          clearTimeout(minuteurRecherche);
          lancerRecherche(terme);
        }
      }
    });

    ["touchstart", "click", "keydown", "scroll"].forEach(function (evt) {
      document.addEventListener(evt, function () {
        if (etat.jeton) reporterVerrouillage();
      }, { passive: true });
    });

    // Le bouton « retour » du téléphone ne doit pas quitter l'application.
    window.addEventListener("popstate", function () {
      if (etat.jeton && etat.vue !== "dossiers") {
        revenir();
        history.pushState(null, "", location.href);
      }
    });
    history.pushState(null, "", location.href);
  }

  // -------------------------------------------------------------- démarrage

  function verifierConfiguration() {
    if (!CFG.CLIENT_ID || CFG.CLIENT_ID.indexOf("REMPLACER") === 0) {
      afficherErreurConnexion(
        "L'identifiant Google n'a pas été renseigné dans config.js. " +
        "Contactez l'administrateur de l'application.");
      $("btn-connexion").disabled = true;
      return false;
    }
    return true;
  }

  function demarrer() {
    brancherEvenements();
    if (!verifierConfiguration()) return;

    // Reprise d'une session en cours (retour sur l'onglet, écran verrouillé).
    try {
      var j = sessionStorage.getItem("dgcl_jeton");
      var e = Number(sessionStorage.getItem("dgcl_expire") || 0);
      if (j && Date.now() < e - 60000) {
        etat.jeton = j;
        etat.expireA = e;
        demarrerSession();
        return;
      }
    } catch (err) { /* sessionStorage indisponible */ }

    montrer($("ecran-connexion"), true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", demarrer);
  } else {
    demarrer();
  }

  // Service worker : mise en cache de l'interface pour un démarrage rapide.
  // Aucun document du registre n'est mis en cache.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }
})();
