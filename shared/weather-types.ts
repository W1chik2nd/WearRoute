export type Weather = {
  tempC: number;
  condition: string;
};

export type ForecastDay = {
  date: string;
  /**
   * "forecast": a live provider forecast. "typical": the average for this
   * calendar date over recent years, used beyond the ~16-day forecast window.
   */
  basis: "forecast" | "typical";
  condition: string;
  minTempC: number;
  maxTempC: number;
  /** For typical days: the share of recent years with ≥1 mm of rain. */
  precipitationProbability: number;
  /** Null for typical days: the historical archive has no UV index. */
  uvIndex: number | null;
  maxWindKph: number;
};

/** A day whose live forecast moved enough since the plan was generated. */
export type WeatherChange = {
  date: string;
  /** rain/dry: the rain chance crossed 50%. warmer/colder: high moved 5 °C+. */
  kind: "rain" | "dry" | "warmer" | "colder";
  /** Rain chance in % or high in °C, matching `kind`. */
  before: number;
  after: number;
};

export type TripForecast = {
  source: "Open-Meteo" | "MET Norway";
  available: boolean;
  note: string;
  days: ForecastDay[];
};

export type TripWeather = {
  trip: {
    id: string;
    destination: string;
    destinationDetail: string;
    startDate: string;
    endDate: string;
    dayCount: number;
  };
  forecast: TripForecast;
  /** Days that changed since the outfits were planned; empty when none. */
  changes: WeatherChange[];
};
