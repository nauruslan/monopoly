import { IsOptional, IsString, MaxLength } from "class-validator";

export class GuestDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  displayName?: string;
}
