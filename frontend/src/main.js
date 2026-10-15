import freighter from "@stellar/freighter-api";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

// --- Configuración -------------------------------------------------------
const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID ?? "";
const RPC_URL = "https://soroban-testnet.stellar.org";
const RED = Networks.TESTNET;
const EXPERT = "https://stellar.expert/explorer/testnet";
// Cuenta "vacía" que usa el SDK para simular lecturas sin wallet conectada.
const CUENTA_LECTURA = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const STROOPS_POR_XLM = 10_000_000n;

const MENSAJES_ERROR = {
  1: "La tanda ya estaba inicializada.",
  2: "El contrato todavía no tiene una tanda configurada.",
  3: "Tu cuenta no está en la lista de esta tanda.",
  4: "Ya aportaste en esta ronda. Espera a que aporten los demás.",
  5: "La tanda ya terminó.",
  6: "Los datos de la tanda no son válidos.",
};

const servidor = new rpc.Server(RPC_URL);
const contrato = CONTRACT_ID ? new Contract(CONTRACT_ID) : null;

let miCuenta = null;
let estado = null;

// --- Utilidades -----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const corta = (dir) => `${dir.slice(0, 4)}…${dir.slice(-4)}`;
const aXlm = (stroops) => {
  const entero = BigInt(stroops);
  const xlm = Number(entero / STROOPS_POR_XLM) + Number(entero % STROOPS_POR_XLM) / 1e7;
  return xlm.toLocaleString("es-MX", { maximumFractionDigits: 7 });
};

function avisar(texto, tipo = "") {
  const aviso = $("aviso");
  aviso.className = `aviso ${tipo}`;
  aviso.innerHTML = texto;
}

function traducirError(err) {
  const texto = String(err?.message ?? err);
  const codigo = texto.match(/Error\(Contract, #(\d+)\)/);
  if (codigo && MENSAJES_ERROR[codigo[1]]) return MENSAJES_ERROR[codigo[1]];
  if (/User declined|rejected/i.test(texto)) return "Cancelaste la firma en Freighter.";
  if (/balance|underfunded/i.test(texto)) return "Tu cuenta no tiene suficiente XLM para aportar.";
  return texto;
}

// --- Lectura del contrato (simulación, sin costo) -----------------------
async function leerEstado() {
  const fuente = new Account(miCuenta ?? CUENTA_LECTURA, "0");
  const tx = new TransactionBuilder(fuente, { fee: BASE_FEE, networkPassphrase: RED })
    .addOperation(contrato.call("estado"))
    .setTimeout(30)
    .build();
  const sim = await servidor.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return scValToNative(sim.result.retval);
}

// --- Escritura: aportar (genera la transacción on-chain) -----------------
async function aportar() {
  const boton = $("btn-aportar");
  boton.disabled = true;
  avisar("Preparando la transacción…");

  try {
    const cuenta = await servidor.getAccount(miCuenta);
    let tx = new TransactionBuilder(cuenta, { fee: BASE_FEE, networkPassphrase: RED })
      .addOperation(contrato.call("aportar", new Address(miCuenta).toScVal()))
      .setTimeout(120)
      .build();

    const sim = await servidor.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
    tx = rpc.assembleTransaction(tx, sim).build();

    avisar("Confirma la firma en Freighter…");
    const firmada = await freighter.signTransaction(tx.toXDR(), {
      networkPassphrase: RED,
      address: miCuenta,
    });
    if (firmada.error) throw new Error(firmada.error.message ?? firmada.error);

    avisar("Enviando a Stellar Testnet…");
    const envio = await servidor.sendTransaction(
      TransactionBuilder.fromXDR(firmada.signedTxXdr, RED),
    );
    if (envio.status === "ERROR") throw new Error("La red rechazó la transacción.");

    const resultado = await esperarConfirmacion(envio.hash);
    if (resultado.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error("La transacción falló en la red.");
    }

    avisar(
      `Aporte registrado. <a href="${EXPERT}/tx/${envio.hash}" target="_blank" rel="noopener">Ver la transacción en Stellar Expert</a>`,
      "exito",
    );
    console.log("Transacción:", `${EXPERT}/tx/${envio.hash}`);
    await refrescar(false);
  } catch (err) {
    avisar(traducirError(err), "error");
    pintarPanel();
  }
}

async function esperarConfirmacion(hash) {
  for (let intento = 0; intento < 20; intento++) {
    const r = await servidor.getTransaction(hash);
    if (r.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return r;
    await new Promise((listo) => setTimeout(listo, 1500));
  }
  throw new Error("La red tardó demasiado en confirmar. Revisa tu historial en Freighter.");
}

   async function mostrarSaldo() {
     if (!miCuenta) return;
     try {
       const r = await fetch(`https://horizon-testnet.stellar.org/accounts/${miCuenta}`);
       const datos = await r.json();
       const xlm = datos.balances.find((b) => b.asset_type === "native");
       $("saldo").textContent = `Tu saldo: ${Number(xlm.balance).toLocaleString("es-MX", { maximumFractionDigits: 2 })} XLM`;
     } catch {
       $("saldo").textContent = "";
     }
   }

// --- Wallet ---------------------------------------------------------------
async function conectar() {
  const { isConnected } = await freighter.isConnected();
  if (!isConnected) {
    avisar(
      'No encontramos Freighter. Instálala desde <a href="https://www.freighter.app" target="_blank" rel="noopener">freighter.app</a> y recarga la página.',
      "error",
    );
    return;
  }

  const acceso = await freighter.requestAccess();
  if (acceso.error) {
    avisar(traducirError(acceso.error.message ?? acceso.error), "error");
    return;
  }

  const red = await freighter.getNetworkDetails();
  if (red.networkPassphrase !== RED) {
    avisar("Cambia Freighter a la red Testnet y vuelve a conectar.", "error");
    return;
  }

  miCuenta = acceso.address;
  $("btn-conectar").textContent = corta(miCuenta);
  $("cuenta").textContent = `Conectado como ${miCuenta}`;
  avisar("");
  pintarPanel();
  mostrarSaldo();
}

// --- Pintar la pantalla --------------------------------------------------
function pintarRueda() {
  const rueda = $("rueda");
  rueda.querySelectorAll(".lugar").forEach((n) => n.remove());

  const { participantes, pagados, ronda, terminada, aporte } = estado;
  const n = participantes.length;

  participantes.forEach((dir, i) => {
    const lugar = document.createElement("div");
    lugar.className = "lugar";
    lugar.style.setProperty("--i", i);
    lugar.style.setProperty("--n", n);
    lugar.textContent = i + 1;
    lugar.title = dir;
    if (pagados.includes(dir)) lugar.classList.add("pagado");
    if (!terminada && i === ronda) lugar.classList.add("cobra");
    if (i < ronda) lugar.classList.add("cobro");
    if (dir === miCuenta) lugar.classList.add("yo");
    rueda.appendChild(lugar);
  });

  const bote = BigInt(aporte) * BigInt(n);
  $("bote").textContent = `${aXlm(bote)} XLM`;
  $("bote-texto").textContent = terminada
    ? "Todos recibieron su bote"
    : `Le toca a ${corta(estado.beneficiario)}`;
  $("ronda").textContent = terminada
    ? `La tanda terminó después de ${n} rondas.`
    : `Ronda ${ronda + 1} de ${n}. Han aportado ${pagados.length} de ${n}.`;
}

function pintarTurnos() {
  const lista = $("turnos");
  lista.innerHTML = "";
  estado.participantes.forEach((dir, i) => {
    const li = document.createElement("li");
    let situacion = "Pendiente";
    if (i < estado.ronda) situacion = "Ya cobró";
    else if (i === estado.ronda && !estado.terminada) {
      situacion = "Cobra en esta ronda";
      li.classList.add("actual");
    }
    const nombre = dir === miCuenta ? `${corta(dir)} (tú)` : corta(dir);
    li.innerHTML = `<span title="${dir}">${nombre}</span><span class="estado-turno">${situacion}</span>`;
    lista.appendChild(li);
  });
}

function pintarPanel() {
  const boton = $("btn-aportar");
  const situacion = $("situacion");
  if (!estado) return;

  const monto = `${aXlm(estado.aporte)} XLM`;
  boton.textContent = `Aportar ${monto}`;

  if (!miCuenta) {
    situacion.textContent = "";
    boton.disabled = true;
  } else if (estado.terminada) {
    situacion.textContent = "La tanda terminó. Todos recibieron su bote.";
    boton.disabled = true;
  } else if (!estado.participantes.includes(miCuenta)) {
    situacion.textContent = "Tu cuenta no está en esta tanda.";
    boton.disabled = true;
  } else if (estado.pagados.includes(miCuenta)) {
    situacion.textContent = `Ya aportaste en la ronda ${estado.ronda + 1}.`;
    boton.disabled = true;
  } else {
    situacion.textContent = `Te falta aportar ${monto} en la ronda ${estado.ronda + 1}.`;
    boton.disabled = false;
  }

  pintarTurnos();
  pintarRueda();
}

async function refrescar(mostrarError = true) {
  try {
    estado = await leerEstado();
    pintarPanel();
    mostrarSaldo();
  } catch (err) {
    if (mostrarError) avisar(`No se pudo leer la tanda: ${traducirError(err)}`, "error");
  }
}

// --- Arranque -------------------------------------------------------------
$("btn-conectar").addEventListener("click", conectar);
$("btn-aportar").addEventListener("click", aportar);

if (!contrato) {
  $("bote").textContent = "Sin contrato";
  $("bote-texto").textContent = "Configura VITE_CONTRACT_ID en el archivo .env";
} else {
  const link = $("link-contrato");
  link.href = `${EXPERT}/contract/${CONTRACT_ID}`;
  link.textContent = CONTRACT_ID;
  refrescar();
  setInterval(() => refrescar(false), 15000);

  // Si la página ya tenía permiso, reconecta sin pedir clic.
  freighter.isAllowed().then(({ isAllowed }) => isAllowed && conectar());
}
