import { useEffect, useState } from "react";
import {
  me,
  setToken,
  getToken,
  logout,
  deleteWardrobeItem,
  ApiError,
  SESSION_EXPIRED_EVENT,
  listTripPlans,
  type AssistantClientAction,
  type AssistantPage,
  type Credentials,
  type TripPlan,
  type User,
} from "./api";
import { LangProvider, useLang } from "./i18n/useLang";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Questionnaire from "./pages/Questionnaire";
import Home from "./pages/index";
import TripPlanner from "./pages/TripPlanner";
import Itinerary from "./pages/Itinerary";
import Wardrobe from "./pages/Wardrobe";
import PhoneUpload from "./pages/PhoneUpload";
import PackingList from "./pages/PackingList";
import TripSetup from "./pages/TripSetup";
import Profile from "./pages/Profile";
import OutfitOverview from "./pages/OutfitOverview";
import TripWeather from "./pages/TripWeather";
import ChatWidget from "./components/ChatWidget";
import { confirmDeleteMessage } from "./i18n/dynamic-strings";

type Route =
  | "landing"
  | "login"
  | "register"
  | "questionnaire"
  | "home"
  | "trips"
  | "tripSetup"
  | "itinerary"
  | "wardrobe"
  | "profile"
  | "packing"
  | "outfit"
  | "weather";

/** ?upload=<token> 是手机扫码进来的上传页,免登录。 */
const uploadToken = new URLSearchParams(window.location.search).get("upload");

function Shell() {
  const { lang, setLang, t } = useLang();
  const [route, setRoute] = useState<Route>("landing");
  const [user, setUser] = useState<User | null>(null);
  // Step-1 credentials live only in memory while the questionnaire is open;
  // nothing is persisted anywhere until /api/register succeeds.
  const [pendingCreds, setPendingCreds] = useState<Credentials | null>(null);
  const [booting, setBooting] = useState(true);
  // 从场景卡片带过来的出行目的:行程设置页(地图+日历)和行程计划页都用它。
  const [scenario, setScenario] = useState<string | undefined>(undefined);
  const [itineraryId, setItineraryId] = useState<string | undefined>(undefined);
  const [packingTripPlanId, setPackingTripPlanId] = useState<string | undefined>(
    undefined
  );
  const [outfitTripPlanId, setOutfitTripPlanId] = useState<string | undefined>(
    undefined
  );
  const openOutfit = (tripPlanId?: string) => {
    setOutfitTripPlanId(tripPlanId);
    setRoute("outfit");
  };
  const [retryPlan, setRetryPlan] = useState<TripPlan | null>(null);
  // Bumped after the assistant deletes an item so an open wardrobe reloads.
  const [wardrobeVersion, setWardrobeVersion] = useState(0);
  const [weatherTripPlanId, setWeatherTripPlanId] = useState<string | null>(null);

  // A stored session the backend could not confirm because it was
  // unreachable (offline, or the free-tier server still waking up).
  const [unreachable, setUnreachable] = useState(false);

  function restoreSession() {
    me()
      .then(({ user }) => {
        setUser(user);
        setUnreachable(false);
        setRoute("home");
      })
      .catch((error) => {
        // Only a 401 means the session is gone (request() already cleared
        // it). Dropping the token on a network error signed people out after
        // every cold start.
        setUnreachable(error instanceof ApiError && error.status === null);
      })
      .finally(() => setBooting(false));
  }

  useEffect(() => {
    // 手机上传页不需要登录态,跳过 me() 免得白等一次请求。
    if (uploadToken || !getToken()) {
      setBooting(false);
      return;
    }
    restoreSession();
  }, []);

  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setRoute("login");
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // This app uses in-memory routes, so the browser does not reset scroll as
  // it would after a normal navigation. Every page must still open at its top.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [route]);

  function handleAuthed(u: User) {
    setUser(u);
    setPendingCreds(null);
    setRoute("home");
  }

  const assistantRoutes: Record<AssistantPage, Route> = {
    home: "home",
    trips: "trips",
    tripSetup: "tripSetup",
    itinerary: "itinerary",
    wardrobe: "wardrobe",
    profile: "profile",
    packing: "packing",
  };

  function openLatestPackingPlan() {
    void listTripPlans().then(({ plans }) => {
      const latest = plans.find((plan) => Boolean(plan.itineraryId));
      if (!latest) {
        setRoute("home");
        return;
      }
      setPackingTripPlanId(latest.id);
      setRoute("packing");
    });
  }

  function handleAssistantActions(actions: AssistantClientAction[]) {
    for (const action of actions) {
      if (action.type === "profileUpdated") setUser(action.user);
      if (action.type === "navigate") {
        if (action.scenario) setScenario(action.scenario);
        if (action.page === "packing") openLatestPackingPlan();
        else setRoute(assistantRoutes[action.page]);
      }
      if (action.type === "tripCreated") setRoute("home");
      if (action.type === "confirmDeleteWardrobeItem") {
        if (window.confirm(confirmDeleteMessage(lang, action.title))) {
          void deleteWardrobeItem(action.id)
            .then(() => setWardrobeVersion((v) => v + 1))
            .catch((error) => window.alert(error instanceof Error ? error.message : String(error)));
        }
      }
      if (action.type === "packingChanged") {
        // The server already stored the ticks; just show that checklist.
        if (action.balance !== undefined) {
          sessionStorage.setItem("wearroute_packing_balance", String(action.balance));
        }
        setPackingTripPlanId(action.tripPlanId);
        setRoute("packing");
      }
    }
  }

  async function handleSignOut() {
    try {
      await logout();
    } catch {
      // token may already be invalid; proceed with local sign-out
    }
    setToken(null);
    setUser(null);
    setRoute("landing");
  }

  // One toggle for the whole app; the stored value survives refresh/redirect.
  const langToggle = (
    <button
      className="nav-link nav-lang"
      onClick={() => setLang(lang === "en" ? "zh" : "en")}
      aria-label={lang === "en" ? "切换到中文" : "Switch to English"}
    >
      {lang === "en" ? "中文" : "EN"}
    </button>
  );

  if (booting) return null;

  if (unreachable) {
    return (
      <main className="auth-page" aria-live="polite">
        <section className="auth-card">
          <h1>{t("unreachableTitle")}</h1>
          <p>{t("unreachableBody")}</p>
          <button
            className="btn-primary"
            onClick={() => {
              setBooting(true);
              restoreSession();
            }}
          >
            {t("unreachableRetry")}
          </button>
        </section>
      </main>
    );
  }

  // 手机扫码进来的上传页:免登录,优先于其他路由。
  if (uploadToken) {
    return <PhoneUpload uploadToken={uploadToken} />;
  }

  // 落地页是满屏铺版,不显示顶部导航;语言切换单独浮在角上。
  if (route === "landing") {
    return (
      <>
        <div className="landing-lang">{langToggle}</div>
        <Landing onEnter={() => setRoute("login")} />
      </>
    );
  }

  return (
    <>
      <nav className="nav">
        <button
          className="nav-brand"
          onClick={() => setRoute(user ? "home" : "landing")}
        >
          {t("brandName")}
        </button>
        <div className="nav-actions">
          {langToggle}
          {user ? (
            <>
              {/* No section jump links in the nav: sections are reached from
                  the dashboard tiles, each page has its own back button. */}
              <span className="nav-user">{user.name}</span>
              <button className="nav-link" onClick={handleSignOut}>
                {t("navSignOut")}
              </button>
            </>
          ) : (
            <>
              <button className="nav-link" onClick={() => setRoute("login")}>
                {t("navSignIn")}
              </button>
              <button className="nav-link" onClick={() => setRoute("register")}>
                {t("navCreateAccount")}
              </button>
            </>
          )}
        </div>
      </nav>

      {user && <ChatWidget onActions={handleAssistantActions} />}

      {route === "login" && (
        <Login onAuthed={handleAuthed} onSwitch={() => setRoute("register")} />
      )}
      {route === "register" && (
        <Register
          onContinue={(creds) => {
            setPendingCreds(creds);
            setRoute("questionnaire");
          }}
          onSwitch={() => setRoute("login")}
        />
      )}
      {route === "questionnaire" && pendingCreds && (
        <Questionnaire
          credentials={pendingCreds}
          onAuthed={handleAuthed}
          onBack={() => setRoute("register")}
        />
      )}
      {route === "home" && user && (
        <Home
          user={user}
          onOpenTrips={() => {
            setRetryPlan(null);
            setRoute("trips");
          }}
          onRetryTrip={(plan) => {
            setRetryPlan(plan);
            setScenario(plan.scenario);
            setItineraryId(undefined);
            setRoute("tripSetup");
          }}
          onOpenWardrobe={() => setRoute("wardrobe")}
          onOpenItinerary={(id) => {
            setScenario("travel");
            setItineraryId(id);
            setRoute("itinerary");
          }}
          onOpenPacking={(tripPlanId) => {
            setPackingTripPlanId(tripPlanId);
            setRoute("packing");
          }}
          onOpenWeather={(tripPlanId) => {
            setWeatherTripPlanId(tripPlanId);
            setRoute("weather");
          }}
          onOpenProfile={() => setRoute("profile")}
          onOpenOutfit={openOutfit}
        />
      )}
      {route === "trips" && user && (
        <TripPlanner
          user={user}
          onBack={() => setRoute("home")}
          onPickScenario={(id) => {
            setRetryPlan(null);
            setScenario(id);
            setItineraryId(undefined);
            setRoute("tripSetup");
          }}
        />
      )}
      {route === "tripSetup" && user && scenario && (
        <TripSetup
          user={user}
          scenario={scenario}
          retryPlan={retryPlan}
          onBack={() => {
            setRetryPlan(null);
            setRoute(retryPlan ? "home" : "trips");
          }}
          onSaved={() => {
            setRetryPlan(null);
            setRoute("home");
          }}
        />
      )}
      {route === "itinerary" && user && (
        <Itinerary
          user={user}
          scenario={scenario}
          tripId={itineraryId}
          onBack={() => setRoute("home")}
        />
      )}
      {route === "wardrobe" && user && (
        <Wardrobe key={wardrobeVersion} onBack={() => setRoute("home")} />
      )}
      {route === "profile" && user && (
        <Profile
          user={user}
          onBack={() => setRoute("home")}
          onSaved={(updated) => setUser(updated)}
        />
      )}
      {route === "packing" && user && packingTripPlanId && (
        <PackingList
          tripPlanId={packingTripPlanId}
          onBack={() => setRoute("home")}
        />
      )}
      {route === "outfit" && user && (
        <OutfitOverview
          tripPlanId={outfitTripPlanId}
          onBack={() => setRoute("home")}
        />
      )}
      {route === "weather" && user && weatherTripPlanId && (
        <TripWeather
          tripPlanId={weatherTripPlanId}
          onBack={() => setRoute("home")}
        />
      )}
    </>
  );
}

export default function App() {
  return (
    <LangProvider>
      <Shell />
    </LangProvider>
  );
}
