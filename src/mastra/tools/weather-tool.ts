import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

interface GeocodingResponse {
  results: {
    latitude: number;
    longitude: number;
    name: string;
  }[];
}
interface WeatherResponse {
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    wind_gusts_10m: number;
    weather_code: number;
  };
}
interface ForecastResponse {
  daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    weather_code: number[];
    precipitation_sum: number[];
  };
}

export const weatherTool = createTool({
  id: 'get-weather',
  description: 'Get current weather for a location',
  inputSchema: z.object({
    location: z.string().describe('City name'),
  }),
  outputSchema: z.object({
    temperature: z.number(),
    feelsLike: z.number(),
    humidity: z.number(),
    windSpeed: z.number(),
    windGust: z.number(),
    conditions: z.string(),
    location: z.string(),
  }),
  execute: async (inputData) => {
    return await getWeather(inputData.location);
  },
});

export const forecastTool = createTool({
  id: 'get-forecast',
  description: 'Get a multi-day weather forecast for a location',
  inputSchema: z.object({
    location: z.string().describe('City name'),
    days: z.number().describe('Number of forecast days'),
  }),
  outputSchema: z.object({
    location: z.string(),
    forecast: z.array(
      z.object({
        date: z.string(),
        maxTemp: z.number(),
        minTemp: z.number(),
        conditions: z.string(),
        precipitation: z.number(),
      })
    ),
  }),
  execute: async (inputData) => {
    return await getForecast(inputData.location, inputData.days);
  },
});

const geocode = async (location: string) => {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
  const res = await fetch(url);
  const data = (await res.json()) as GeocodingResponse;
  return data.results[0];
};

const getWeather = async (location: string) => {
  const geocodingUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`;
  const geocodingResponse = await fetch(geocodingUrl);
  const geocodingData = (await geocodingResponse.json()) as GeocodingResponse;

  if (!geocodingData.results?.[0]) {
    throw new Error(`Location '${location}' not found`);
  }

  const { latitude, longitude, name } = geocodingData.results[0];

  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code`;

  const response = await fetch(weatherUrl);
  const data = (await response.json()) as WeatherResponse;

  return {
    temperature: data.current.temperature_2m,
    feelsLike: data.current.apparent_temperature,
    humidity: data.current.relative_humidity_2m,
    windSpeed: data.current.wind_speed_10m,
    windGust: data.current.wind_gusts_10m,
    conditions: getWeatherCondition(data.current.weather_code),
    location: name,
  };
};

const getForecast = async (location: string, days: number) => {
  const place = await geocode(location);

  const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum&forecast_days=${days}&timezone=auto`;

  const response = await fetch(forecastUrl);
  const data = (await response.json()) as ForecastResponse;

  return {
    location: place.name,
    forecast: data.daily.time.map((date, i) => ({
      date,
      maxTemp: data.daily.temperature_2m_max[i],
      minTemp: data.daily.temperature_2m_min[i],
      conditions: getWeatherCondition(data.daily.weather_code[i]),
      precipitation: data.daily.precipitation_sum[i],
    })),
  };
};

const weatherCache = new Map<string, { data: Awaited<ReturnType<typeof getWeather>>; ts: number }>();

export const getCachedWeather = async (location: string) => {
  const cached = weatherCache.get(location);
  if (cached && Date.now() - cached.ts < 600000) {
    return cached.data;
  }
  const data = await getWeather(location);
  weatherCache.set(location, { data, ts: Date.now() });
  return data;
};

function getWeatherCondition(code: number): string {
  const conditions: Record<number, string> = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow fall',
    73: 'Moderate snow fall',
    75: 'Heavy snow fall',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
  };
  return conditions[code] || 'Unknown';
}
